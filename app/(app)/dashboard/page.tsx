import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { OccupancyDonut } from "@/components/occupancy-donut";
import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import {
  UtilityUsageChart,
  type UtilityUsagePoint,
} from "@/components/utility-usage-chart";
import { requireSession } from "@/lib/auth";
import { effectiveRate, reconcile, round3 } from "@/lib/billing";
import { formatDate, formatTime, money, monthsUntil } from "@/lib/format";
import { nextScheduledDate } from "@/lib/maintenance";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { resetDashboardLayout, saveDashboardLayout } from "./actions";
import { PANEL_KEYS, TILE_KEYS, applyOrder } from "./layout-order";
import { SortableDashboard } from "./sortable-dashboard";

export const metadata: Metadata = { title: "Dashboard" };

/** What each tenant document kind is called on screen. */
const DOC_KIND_LABELS: Record<string, string> = {
  mayors_permit: "Mayor's / Business permit",
  business_permit: "Business permit",
  dti_registration: "DTI",
  bir_registration: "BIR",
  sec_registration: "SEC",
  valid_id: "ID",
  contract: "Contract",
  letter: "Letter",
  memo: "Memo",
  other: "Other",
};

/** What the grip says it is moving, for anyone reading by keyboard. */
const LAYOUT_LABELS: Record<string, string> = {
  "my-calendar": "Coming up",
  collected: "Collected this month",
  receivables: "Receivables",
  attention: "Needs attention",
  overdue: "Overdue accounts",
  approvals: "Awaiting your approval",
  occupancy: "Occupancy",
  notifications: "Notifications",
  "occupancy-by-location": "Occupancy per location",
  "postdated-cheques": "Postdated cheques",
  "utility-usage": "Utility usage",
  "billing-turnaround": "Billing turnaround",
};

/** Spec 3: warn two days before the due date, and once overdue. */
const DUE_SOON_DAYS = 2;
/** Spec 3: six months before a contract ends, to trigger the renewal notice. */
const RENEWAL_NOTICE_MONTHS = 6;
const PDC_HORIZON_DAYS = 30;
/**
 * How far ahead a rent rise is worth flagging.
 *
 * Two months is enough notice to talk to a tenant and rule on it before the
 * date arrives. After the fact, holding a rise means issuing a credit note
 * rather than making a decision.
 */
const ESCALATION_NOTICE_DAYS = 60;
/**
 * How far ahead your own reminders reach on the dashboard.
 *
 * A month is what you can act on. Anything further out belongs on the calendar
 * itself, which is a click away and shows six.
 */
const REMINDER_HORIZON_DAYS = 30;
/**
 * How far ahead a tenant's papers are flagged.
 *
 * Thirty days is enough to renew a mayor's permit without closing; seven is
 * the point at which it stops being a reminder and becomes a problem. Kept as
 * constants so a settings screen can take them over later without the rule
 * itself having to move.
 */
const DOC_EXPIRY_NOTICE_DAYS = 30;
const DOC_EXPIRY_URGENT_DAYS = 7;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const context = await requireSession();
  if (!context.activeCompany) {
    redirect(context.isSuperAdmin ? "/admin/companies" : "/no-company");
  }

  const companyId = context.activeCompany.companyId;
  const permissions = context.permissions;
  const supabase = await createClient();

  const today = new Date().toISOString().slice(0, 10);
  const dueSoonCutoff = new Date(Date.now() + DUE_SOON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const pdcCutoff = new Date(Date.now() + PDC_HORIZON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const escalationHorizon = new Date(
    Date.now() + ESCALATION_NOTICE_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const reminderHorizon = new Date(
    Date.now() + REMINDER_HORIZON_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const docHorizon = new Date(Date.now() + DOC_EXPIRY_NOTICE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  // A year of utility history, so the chart shows a full seasonal cycle.
  const twelveMonthsAgo = new Date(
    new Date().setMonth(new Date().getMonth() - 11),
  )
    .toISOString()
    .slice(0, 8) + "01";

  const seeOccupancy = can(permissions, MODULE.dashboardOccupancy, "view");
  const seeIncome = can(permissions, MODULE.dashboardIncome, "view");
  const seeUtilities = can(permissions, MODULE.dashboardUtilities, "view");
  const seeNotifications = can(permissions, MODULE.dashboardNotifications, "view");
  const seeCheques = can(permissions, MODULE.dashboardCheques, "view");
  /*
   * How long the billing takes to follow the meter reading is a question
   * about the people doing it, so it is the company's administrator who
   * sees it, not whoever happens to have the utilities panel.
   */
  const seeTurnaround =
    context.isSuperAdmin || Boolean(context.activeCompany?.isCompanyAdmin);
  const showAttention = view === "attention";
  const seesAnyPanel =
    seeOccupancy || seeIncome || seeUtilities || seeNotifications || seeCheques;

  const [
    { data: locations },
    { data: openInvoices },
    { data: contracts },
    { data: cheques },
    { data: paymentsThisMonth },
    { data: periods },
    { data: allCheques },
    { data: risesDue },
    { data: myReminders },
    { data: dueSchedules },
    { data: expiringDocs },
    { data: turnaroundPeriods },
  ] = await Promise.all([
    seeOccupancy
      ? supabase
          .from("locations")
          .select("id, code, name, units(id, status, monthly_rate)")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .order("code")
          .returns<
            {
              id: string;
              code: string;
              name: string;
              units: { id: string; status: string; monthly_rate: string }[];
            }[]
          >()
      : Promise.resolve({ data: null }),
    can(permissions, MODULE.billingInvoices, "view")
      ? supabase
          .from("invoices")
          .select(
            "id, invoice_no, tenant_id, due_date, total, amount_paid, credited_amount, tenants(company_name)",
          )
          .eq("company_id", companyId)
          .in("status", ["released", "partially_paid"])
          .order("due_date")
          .returns<
            {
              id: string;
              invoice_no: string;
              tenant_id: string;
              due_date: string;
              total: string;
              amount_paid: string;
              credited_amount: string;
              tenants: { company_name: string } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    can(permissions, MODULE.contracts, "view")
      ? supabase
          .from("contracts")
          .select("id, contract_no, end_date, monthly_rent, tenants(company_name)")
          .eq("company_id", companyId)
          .eq("status", "active")
          .order("end_date")
          .returns<
            {
              id: string;
              contract_no: string;
              end_date: string;
              monthly_rent: string;
              tenants: { company_name: string } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    can(permissions, MODULE.paymentsPdc, "view")
      ? supabase
          .from("postdated_checks")
          .select(
            "id, check_no, bank, amount, maturity_date, status, payment_id, tenants(company_name)",
          )
          .eq("company_id", companyId)
          // Cleared cheques are carried too: one that never became a collection
          // leaves its invoice looking unpaid.
          .or(
            `and(status.in.(pending,matured),maturity_date.lte.${pdcCutoff}),and(status.eq.cleared,payment_id.is.null)`,
          )
          .order("maturity_date")
          .returns<
            {
              id: string;
              check_no: string;
              bank: string;
              amount: string;
              maturity_date: string;
              status: string;
              payment_id: string | null;
              tenants: { company_name: string } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    seeIncome
      ? supabase
          .from("payments")
          .select("amount")
          .eq("company_id", companyId)
          .eq("status", "posted")
          .gte("payment_date", monthStart)
      : Promise.resolve({ data: null }),
    seeUtilities
      ? supabase
          .from("utility_periods")
          .select(
            "id, utility, period_start, provider_amount, provider_consumption, manual_rate, locations(code), meter_readings(consumption)",
          )
          .eq("company_id", companyId)
          .gte("period_start", twelveMonthsAgo)
          .order("period_start", { ascending: false })
          .limit(60)
          .returns<
            {
              id: string;
              utility: string;
              period_start: string;
              provider_amount: string;
              provider_consumption: string;
              manual_rate: number | null;
              locations: { code: string } | null;
              meter_readings: { consumption: string }[];
            }[]
          >()
      : Promise.resolve({ data: null }),
    seeCheques
      ? supabase
          .from("postdated_checks")
          .select("id, amount, maturity_date, status")
          .eq("company_id", companyId)
          .returns<
            {
              id: string;
              amount: string;
              maturity_date: string;
              status: string;
            }[]
          >()
      : Promise.resolve({ data: null }),
    /*
     * Rent rises nobody has ruled on yet. They are worth surfacing before the
     * date arrives: once an invoice has gone out at the higher figure, holding
     * it is a credit note rather than a decision.
     */
    seeNotifications
      ? supabase
          .from("contract_escalations")
          .select(
            `id, effective_date, rate_percent, contract_id,
             contracts(contract_no, status, tenants(company_name))`,
          )
          .eq("company_id", companyId)
          .eq("decision", "pending")
          .lte("effective_date", escalationHorizon)
          .order("effective_date")
          .returns<
            {
              id: string;
              effective_date: string;
              rate_percent: string;
              contract_id: string;
              contracts: {
                contract_no: string;
                status: string;
                tenants: { company_name: string } | null;
              } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    /*
     * Your own reminders. Not behind a dashboard permission, because there is
     * nothing here to permit: the calendar is personal, the policy already
     * limits it to your own rows, and a reminder you wrote to yourself should
     * not need an administrator's grant to reach you.
     */
    supabase
      .from("calendar_events")
      .select("id, title, event_date, event_time")
      .eq("user_id", context.userId)
      .eq("is_done", false)
      .lte("event_date", reminderHorizon)
      .order("event_date")
      .limit(8)
      .returns<
        {
          id: string;
          title: string;
          event_date: string;
          event_time: string | null;
        }[]
      >(),
    // Scheduled maintenance sits alongside them: it is company work rather
    // than personal, so it needs the module's view right.
    can(permissions, MODULE.maintenanceScheduled, "view")
      ? supabase
          .from("maintenance_schedules")
          .select("id, title, month_of_year, day_of_month, locations(code)")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .returns<
            {
              id: string;
              title: string;
              month_of_year: number | null;
              day_of_month: number | null;
              locations: { code: string } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    /*
     * Tenant papers coming up for renewal. Behind the tenants module, so a
     * reader who may not see the tenant is not told about their permit.
     */
    can(permissions, MODULE.tenants, "view")
      ? supabase
          .from("documents")
          .select("id, title, doc_kind, expires_on, tenant_id, tenants(company_name)")
          .eq("company_id", companyId)
          .eq("no_expiry", false)
          .not("expires_on", "is", null)
          .not("tenant_id", "is", null)
          .lte("expires_on", docHorizon)
          .order("expires_on")
          .returns<
            {
              id: string;
              title: string;
              doc_kind: string;
              expires_on: string;
              tenant_id: string;
              tenants: { company_name: string } | null;
            }[]
          >()
      : Promise.resolve({ data: null }),
    /*
     * Every utility period with whatever invoices carry it, so the delay
     * between keying one in and billing it can be read off. Loaded only for
     * the administrator who is shown it.
     */
    seeTurnaround
      ? supabase
          .from("utility_periods")
          .select(
            "id, utility, period_start, period_end, created_at, locations(code), invoice_lines(invoices(created_at, status))",
          )
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .limit(60)
          .returns<
            {
              id: string;
              utility: string;
              period_start: string;
              period_end: string;
              created_at: string;
              locations: { code: string } | null;
              invoice_lines: {
                invoices: { created_at: string; status: string } | null;
              }[];
            }[]
          >()
      : Promise.resolve({ data: null }),
  ]);

  /*
   * One dated list from two sources: what you wrote down for yourself, and
   * the maintenance the building is due. They belong together because they
   * answer the same question -- what is coming up that I should act on --
   * and keeping them apart only means checking two places.
   */
  type Upcoming = {
    key: string;
    date: string;
    time: string | null;
    title: string;
    note: string;
    href: string;
    kind: "personal" | "maintenance";
  };

  const upcomingItems: Upcoming[] = [
    ...(myReminders ?? []).map((reminder) => ({
      key: `event-${reminder.id}`,
      date: reminder.event_date,
      time: reminder.event_time,
      title: reminder.title,
      note: "Your reminder",
      href: `/calendar/${reminder.id}`,
      kind: "personal" as const,
    })),
    ...(dueSchedules ?? []).flatMap((schedule) => {
      const date = nextScheduledDate(schedule, today);
      // A schedule with no month names no date, and the horizon is the same
      // month ahead the reminders use.
      if (!date || date > reminderHorizon) return [];
      return [
        {
          key: `sched-${schedule.id}`,
          date,
          time: null,
          title: schedule.title,
          note: `Scheduled maintenance${
            schedule.locations?.code ? ` · ${schedule.locations.code}` : ""
          }`,
          href: "/maintenance/schedules",
          kind: "maintenance" as const,
        },
      ];
    }),
  ]
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.time ?? "").localeCompare(b.time ?? ""),
    )
    .slice(0, 8);

  const upcomingOverdue = upcomingItems.filter(
    (item) => item.date < today,
  ).length;

  // The cheque panel counts every live cheque, not just the imminent ones the
  // notification query narrows to.
  const pdcRows = allCheques ?? [];
  const pdcOnHand = pdcRows.filter(
    (row) => row.status === "pending" || row.status === "matured",
  );
  const pdcMaturingSoon = pdcOnHand.filter(
    (row) => row.maturity_date > today && row.maturity_date <= pdcCutoff,
  );
  const pdcPastMaturity = pdcOnHand.filter((row) => row.maturity_date <= today);
  const pdcBounced = pdcRows.filter((row) => row.status === "bounced");
  const pdcOnHandValue = pdcOnHand.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );

  // --- Occupancy -----------------------------------------------------------
  const occupancyRows = (locations ?? []).map((location) => {
    const units = (location.units ?? []).filter((unit) => unit.status !== "inactive");
    const occupied = units.filter((unit) => unit.status === "occupied");
    return {
      id: location.id,
      code: location.code,
      name: location.name,
      total: units.length,
      occupied: occupied.length,
      vacant: units.filter((unit) => unit.status === "vacant").length,
      rate: units.length ? (occupied.length / units.length) * 100 : 0,
      contracted: occupied.reduce((sum, unit) => sum + Number(unit.monthly_rate), 0),
    };
  });

  const totalUnits = occupancyRows.reduce((sum, row) => sum + row.total, 0);
  const totalOccupied = occupancyRows.reduce((sum, row) => sum + row.occupied, 0);
  // Anything neither occupied nor let is vacant space, so the ring adds up.
  const totalVacant = totalUnits - totalOccupied;

  // --- Receivables ---------------------------------------------------------
  const withBalance = (openInvoices ?? [])
    .map((invoice) => ({
      ...invoice,
      balance:
        Number(invoice.total) -
        Number(invoice.amount_paid) -
        Number(invoice.credited_amount),
    }))
    .filter((invoice) => invoice.balance > 0);

  const overdue = withBalance.filter((invoice) => invoice.due_date < today);
  const dueSoon = withBalance.filter(
    (invoice) => invoice.due_date >= today && invoice.due_date <= dueSoonCutoff,
  );
  const receivables = withBalance.reduce((sum, invoice) => sum + invoice.balance, 0);

  const renewals = (contracts ?? []).filter((contract) => {
    const months = monthsUntil(contract.end_date);
    return months !== null && months <= RENEWAL_NOTICE_MONTHS;
  });

  const collected = (paymentsThisMonth ?? []).reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );

  // A cheque that has reached its date is the cashier's job today; one still
  // dated ahead is only a heads-up. They are listed apart for that reason.
  const chequesToCollect = (cheques ?? []).filter(
    (cheque) => cheque.status === "cleared",
  );
  const chequesToDeposit = (cheques ?? []).filter(
    (cheque) => cheque.status !== "cleared" && cheque.maturity_date <= today,
  );
  const chequesMaturingSoon = (cheques ?? []).filter(
    (cheque) => cheque.status !== "cleared" && cheque.maturity_date > today,
  );
  const depositValue = chequesToDeposit.reduce(
    (sum, cheque) => sum + Number(cheque.amount),
    0,
  );

  // Only rises on live contracts are worth ruling on.
  const escalationsDue = (risesDue ?? []).filter(
    (row) => row.contracts?.status === "active",
  );

  /*
   * Overdue is counted by tenant rather than by invoice, and stands on its own
   * tile: it is the one figure somebody chases, and three invoices against one
   * tenant is one conversation, not three. Left inside "needs attention" it
   * was a number nobody could act on without opening it first.
   */
  const overdueTenants = new Map<string, { name: string; balance: number }>();
  for (const invoice of overdue) {
    const held = overdueTenants.get(invoice.tenant_id) ?? {
      name: invoice.tenants?.company_name ?? "Unknown tenant",
      balance: 0,
    };
    held.balance += invoice.balance;
    overdueTenants.set(invoice.tenant_id, held);
  }
  const overdueValue = overdue.reduce((sum, invoice) => sum + invoice.balance, 0);

  // The tile counts what it names; the panel also lists the overdue, which
  // now have a tile of their own but still belong in one place to read.
  const notificationCount =
    dueSoon.length +
    renewals.length +
    escalationsDue.length +
    (cheques?.length ?? 0);
  /*
   * Papers already lapsed, or about to. Sorted soonest first, which puts the
   * expired ones at the top where they belong.
   */
  const docAlerts = (expiringDocs ?? []).map((doc) => {
    const days = Math.ceil(
      (new Date(`${doc.expires_on}T00:00:00`).getTime() -
        new Date(`${today}T00:00:00`).getTime()) /
        86_400_000,
    );
    return { ...doc, days };
  });

  const panelCount = notificationCount + overdue.length + docAlerts.length;

  /*
   * What is sitting in the queue waiting on this reader.
   *
   * Approving is the one job nobody is prompted to do: the request is raised
   * somewhere else, by somebody else, and until it is signed off the thing it
   * describes has not happened. Counting only the modules this reader can
   * actually approve keeps it a call to act rather than a number they can do
   * nothing about.
   */
  const canApproveAny = Object.values(permissions).some((entry) => entry.approve);
  const { data: queued } = canApproveAny
    ? await supabase
        .from("approval_requests")
        .select("module_key")
        .eq("company_id", companyId)
        .eq("status", "pending")
        .limit(200)
        .returns<{ module_key: string }[]>()
    : { data: [] };
  const awaitingMe = (queued ?? []).filter((row) =>
    can(permissions, row.module_key, "approve"),
  ).length;

  // Where this reader dragged things to, laid over the built-in order. A
  // missing row simply means they have never moved anything.
  const { data: layout } = await supabase
    .from("dashboard_layouts")
    .select("panels, tiles")
    .eq("user_id", context.userId)
    .eq("company_id", companyId)
    .maybeSingle<{ panels: string[]; tiles: string[] }>();

  const panelOrder = applyOrder(PANEL_KEYS, layout?.panels);
  const tileOrder = applyOrder(TILE_KEYS, layout?.tiles);

  /**
   * The same reconciliation the table shows, shaped for the chart.
   *
   * Only the share is plotted: electricity is kWh and water is cubic metres,
   * so the raw figures cannot share an axis, but the proportion left
   * unaccounted for can.
   */
  // Twelve month slots, oldest first, so a month never billed shows as a gap.
  const utilityMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (11 - i));
    return {
      key: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString("en-PH", { month: "short" }),
    };
  });

  const utilityChartPoints: UtilityUsagePoint[] = (periods ?? []).map(
    (period) => {
      const tenantTotal = (period.meter_readings ?? []).reduce(
        (sum, row) => sum + Number(row.consumption ?? 0),
        0,
      );
      const check = reconcile(
        Number(period.provider_consumption),
        tenantTotal,
      );
      return {
        periodId: period.id,
        periodStart: period.period_start,
        periodLabel: formatDate(period.period_start),
        monthLabel: new Date(period.period_start + "T00:00:00").toLocaleDateString("en-PH", { month: "short" }),
        utility: period.utility,
        // reconcile() is already signed loss-negative, so the bar hangs the
        // right way without help.
        unbilledPct: check.percentage,
        unbilledUnits: check.difference,
        unit: period.utility === "water" ? "cu.m" : "kWh",
        locationCode: period.locations?.code ?? "—",
      };
    },
  );

  /*
   * How long a utility period waits before it is billed.
   *
   * Measured from when the period was keyed in to when the first invoice
   * carrying it was generated. Both are the moment of the act rather than
   * the dates written on them: a period covering July can be entered in
   * August, and it is the delay in the office that this is asking about.
   *
   * A cancelled invoice does not count as having billed anything, so a
   * period whose only invoice was cancelled reads as still waiting.
   */
  const turnaroundRows = (turnaroundPeriods ?? []).map((period) => {
    const entered = period.created_at.slice(0, 10);
    const billedAt = (period.invoice_lines ?? [])
      .map((line) => line.invoices)
      .filter((invoice) => invoice && invoice.status !== "cancelled")
      .map((invoice) => invoice!.created_at)
      .sort()[0];

    const days = (from: string, to: string) =>
      Math.max(
        0,
        Math.round(
          (new Date(to.slice(0, 10)).getTime() -
            new Date(from).getTime()) /
            86_400_000,
        ),
      );

    return {
      id: period.id,
      utility: period.utility,
      location: period.locations?.code ?? null,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      entered,
      billedOn: billedAt ? billedAt.slice(0, 10) : null,
      lag: billedAt ? days(entered, billedAt) : null,
      waiting: billedAt ? null : days(entered, today),
    };
  });

  const billedPeriods = turnaroundRows.filter((row) => row.lag !== null);
  const waitingPeriods = turnaroundRows
    .filter((row) => row.waiting !== null)
    .sort((a, b) => (b.waiting ?? 0) - (a.waiting ?? 0));

  const averageLag =
    billedPeriods.length > 0
      ? Math.round(
          (billedPeriods.reduce((sum, row) => sum + (row.lag ?? 0), 0) /
            billedPeriods.length) *
            10,
        ) / 10
      : null;
  const slowest = billedPeriods.reduce<(typeof billedPeriods)[number] | null>(
    (worst, row) => (!worst || (row.lag ?? 0) > (worst.lag ?? 0) ? row : worst),
    null,
  );
  const longestWait = waitingPeriods[0] ?? null;

  // Most recent first: the question is usually about how it is going now.
  const recentTurnaround = [...billedPeriods]
    .sort((a, b) => b.entered.localeCompare(a.entered))
    .slice(0, 8);

  return (
    <>
      <PageHeader
        title={context.activeCompany.companyName}
        description="Occupancy, receivables and what needs attention this week."
      />

      {/* Which company panels a role sees is set per role. Somebody granted
          none still has their own reminders below, so say what is missing
          rather than claim the page is empty. */}
      {!seesAnyPanel ? (
        <Card title="Only your own reminders here">
          <p className="text-sm muted">
            Your role does not include any company dashboard panels. An
            administrator can grant them under Administration → Roles &amp;
            permissions, in the Dashboard group — occupancy, income, utility
            usage and the notifications panel are each granted separately.
          </p>
        </Card>
      ) : null}

      {chequesToDeposit.length > 0 ? (
        <div
          className="card mb-6"
          style={{ borderColor: "var(--danger)", borderWidth: "1.5px" }}
        >
          <div className="card-body flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm">
              <strong style={{ color: "var(--danger)" }}>
                {chequesToDeposit.length} cheque
                {chequesToDeposit.length === 1 ? " has" : "s have"} matured and{" "}
                {chequesToDeposit.length === 1 ? "is" : "are"} still undeposited
              </strong>
              <span className="muted">
                {" "}
                — {money(depositValue)} waiting to be banked.
              </span>
            </p>
            <Link
              href="/payments/pdc/deposit-slip"
              className="btn btn-primary btn-sm"
            >
              Prepare deposit slip
            </Link>
          </div>
        </div>
      ) : null}

      <SortableDashboard
        tileOrder={tileOrder}
        panelOrder={panelOrder}
        defaultTileOrder={[...TILE_KEYS]}
        defaultPanelOrder={[...PANEL_KEYS]}
        labels={LAYOUT_LABELS}
        saveAction={saveDashboardLayout}
        resetAction={resetDashboardLayout}
        tiles={{
          collected: seeIncome ? (
            <StatTile
              label="Collected this month"
              value={money(collected)}
              hint="Posted payments"
              tone="money"
              href="/reports/collections"
            />
          ) : null,
          receivables: can(permissions, MODULE.billingInvoices, "view") ? (
            <StatTile
              label="Receivables"
              value={money(receivables)}
              hint={`${withBalance.length} open invoice(s)`}
              href="/reports/receivables"
            />
          ) : null,
          attention: seeNotifications ? (
            <StatTile
              label="Needs attention"
              value={notificationCount}
              hint="Due soon, renewals, rent rises, cheques"
              href={showAttention ? "/dashboard" : "/dashboard?view=attention"}
            />
          ) : null,
          /*
           * Counted by tenant, valued by what they owe. One tenant three
           * invoices behind is one account to chase, not three, and the money
           * is the figure the conversation is actually about.
           */
          overdue: can(permissions, MODULE.billingInvoices, "view") ? (
            <StatTile
              label="Overdue accounts"
              value={overdueTenants.size}
              hint={
                overdueTenants.size === 0
                  ? "Nobody is behind"
                  : `${money(overdueValue)} across ${overdue.length} invoice${
                      overdue.length === 1 ? "" : "s"
                    }`
              }
              tone={overdueTenants.size > 0 ? "money" : "default"}
              href="/reports/receivables"
            />
          ) : null,
          approvals: canApproveAny ? (
            <StatTile
              label="Awaiting your approval"
              value={awaitingMe}
              hint={
                awaitingMe > 0
                  ? "Nothing here has taken effect until it is signed off"
                  : "Nothing is waiting on you"
              }
              href="/approvals"
            />
          ) : null,
        }}
        panels={{
          "my-calendar": (
            <Card
              title="Coming up"
              description={
                upcomingItems.length > 0
                  ? `${upcomingOverdue} overdue · next ${REMINDER_HORIZON_DAYS} days`
                  : "Your reminders and the maintenance the building is due."
              }
              bodyClassName=""
            >
              {upcomingItems.length > 0 ? (
                <div className="table-scroll">
                  <table className="table">
                    <tbody>
                      {upcomingItems.map((item) => (
                        <tr key={item.key}>
                          <td className="text-xs" style={{ width: "9rem" }}>
                            {formatDate(item.date)}
                            {formatTime(item.time) ? (
                              <p className="muted">{formatTime(item.time)}</p>
                            ) : null}
                            {item.date < today ? (
                              <p style={{ color: "var(--danger)" }}>overdue</p>
                            ) : null}
                          </td>
                          <td>
                            <Link
                              href={item.href}
                              className="text-sm"
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {item.title}
                            </Link>
                            <p className="text-xs muted">{item.note}</p>
                          </td>
                          <td className="text-right">
                            <span className="badge">{item.kind}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="card-body">
                  <EmptyState>
                    Nothing due in the next {REMINDER_HORIZON_DAYS} days.
                  </EmptyState>
                </div>
              )}
              <div className="card-body">
                <Link href="/calendar" className="btn btn-secondary btn-sm">
                  Open your calendar
                </Link>
              </div>
            </Card>
          ),
          occupancy: seeOccupancy ? (
            <Card
              title="Occupancy"
              description="Let against vacant, across every location."
            >
              <OccupancyDonut occupied={totalOccupied} vacant={totalVacant} />
            </Card>
          ) : null,

          notifications:
            seeNotifications && showAttention ? (
              <Card
            title="Notifications"
            description="Overdue and near-due billings, contracts approaching renewal, and cheques nearing maturity."
            bodyClassName=""
          >
            {panelCount > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    {docAlerts.map((doc) => (
                      <tr key={`doc-${doc.id}`}>
                        <td style={{ width: "9rem" }}>
                          <span
                            className="badge"
                            style={
                              doc.days < 0
                                ? { background: "var(--danger)", color: "#fff" }
                                : { color: "var(--danger)" }
                            }
                          >
                            {doc.days < 0 ? "expired" : "expiring"}
                          </span>
                        </td>
                        <td>
                          <Link
                            href={`/tenants/${doc.tenant_id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {doc.tenants?.company_name ?? "Unknown tenant"}
                          </Link>{" "}
                          — {DOC_KIND_LABELS[doc.doc_kind] ?? doc.doc_kind}
                          <p className="text-xs muted">
                            {doc.days < 0
                              ? `Expired ${formatDate(doc.expires_on)}`
                              : doc.days === 0
                                ? `Expires today, ${formatDate(doc.expires_on)}`
                                : `Expires in ${doc.days} day${doc.days === 1 ? "" : "s"} — ${formatDate(doc.expires_on)}`}
                            {doc.days >= 0 && doc.days <= DOC_EXPIRY_URGENT_DAYS
                              ? " · renew now"
                              : ""}
                          </p>
                        </td>
                      </tr>
                    ))}
                    {overdue.map((invoice) => (
                      <tr key={`overdue-${invoice.id}`}>
                        <td style={{ width: "9rem" }}>
                          <span className="badge" style={{ color: "var(--danger)" }}>
                            overdue
                          </span>
                        </td>
                        <td>
                          <Link
                            href={`/billing/invoices/${invoice.id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {invoice.invoice_no}
                          </Link>{" "}
                          — {invoice.tenants?.company_name}
                          <p className="text-xs muted">
                            Due {formatDate(invoice.due_date)}
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          {money(invoice.balance)}
                        </td>
                      </tr>
                    ))}

                    {dueSoon.map((invoice) => (
                      <tr key={`duesoon-${invoice.id}`}>
                        <td>
                          <span className="badge">due soon</span>
                        </td>
                        <td>
                          <Link
                            href={`/billing/invoices/${invoice.id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {invoice.invoice_no}
                          </Link>{" "}
                          — {invoice.tenants?.company_name}
                          <p className="text-xs muted">
                            Due {formatDate(invoice.due_date)}
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          {money(invoice.balance)}
                        </td>
                      </tr>
                    ))}

                    {renewals.map((contract) => {
                      const months = monthsUntil(contract.end_date);
                      return (
                        <tr key={`renewal-${contract.id}`}>
                          <td>
                            <span className="badge">renewal</span>
                          </td>
                          <td>
                            <Link
                              href={`/contracts/${contract.id}`}
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {contract.contract_no}
                            </Link>{" "}
                            — {contract.tenants?.company_name}
                            <p className="text-xs muted">
                              Ends {formatDate(contract.end_date)}
                              {months !== null
                                ? ` · ${months <= 0 ? "now" : `${months} month(s)`}`
                                : ""}
                            </p>
                          </td>
                          <td className="text-right tabular-nums">
                            {money(contract.monthly_rent)}
                          </td>
                        </tr>
                      );
                    })}

                    {/* A rise nobody has ruled on. Flagged before the date so
                        holding it is still a decision rather than a credit
                        note. */}
                    {escalationsDue.map((rise) => (
                      <tr key={`rise-${rise.id}`}>
                        <td>
                          <span className="badge">rent rise</span>
                        </td>
                        <td>
                          <Link
                            href={`/contracts/${rise.contract_id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {rise.contracts?.contract_no}
                          </Link>{" "}
                          — {rise.contracts?.tenants?.company_name}
                          <p className="text-xs muted">
                            {Number(rise.rate_percent)}% due{" "}
                            {formatDate(rise.effective_date)} · apply it or hold
                            it
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="muted text-xs">awaiting</span>
                        </td>
                      </tr>
                    ))}

                    {chequesToCollect.map((cheque) => (
                      <tr key={`collect-${cheque.id}`}>
                        <td>
                          <span className="badge badge-brand">collect</span>
                        </td>
                        <td>
                          <Link
                            href={`/payments/pdc/${cheque.id}/collect`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {cheque.check_no}
                          </Link>{" "}
                          — {cheque.tenants?.company_name}
                          <p className="text-xs muted">
                            {cheque.bank} · cleared — post the collection
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          {money(cheque.amount)}
                        </td>
                      </tr>
                    ))}

                    {chequesToDeposit.map((cheque) => (
                      <tr key={`deposit-${cheque.id}`}>
                        <td>
                          <span className="badge" style={{ color: "var(--danger)" }}>
                            deposit
                          </span>
                        </td>
                        <td>
                          <Link
                            href="/payments/pdc/deposit-slip"
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {cheque.check_no}
                          </Link>{" "}
                          — {cheque.tenants?.company_name}
                          <p className="text-xs muted">
                            {cheque.bank} · matured{" "}
                            {formatDate(cheque.maturity_date)} — bank it
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          {money(cheque.amount)}
                        </td>
                      </tr>
                    ))}

                    {chequesMaturingSoon.map((cheque) => (
                      <tr key={`pdc-${cheque.id}`}>
                        <td>
                          <span className="badge">cheque</span>
                        </td>
                        <td>
                          <Link
                            href="/payments/pdc"
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {cheque.check_no}
                          </Link>{" "}
                          — {cheque.tenants?.company_name}
                          <p className="text-xs muted">
                            {cheque.bank} · matures {formatDate(cheque.maturity_date)}
                          </p>
                        </td>
                        <td className="text-right tabular-nums">
                          {money(cheque.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>Nothing needs attention right now.</EmptyState>
            )}
              </Card>
            ) : null,

          "occupancy-by-location": seeOccupancy ? (
          <Card title="Occupancy per location" bodyClassName="">
            {occupancyRows.length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th className="text-right">Units</th>
                      <th className="text-right">Vacant</th>
                      <th className="text-right">Occupancy</th>
                      {seeIncome ? <th className="text-right">Rent</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {occupancyRows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <Link
                            href={`/properties/${row.id}`}
                            style={{ color: "var(--color-brand-600)" }}
                          >
                            {row.code}
                          </Link>
                          <p className="text-xs muted">{row.name}</p>
                        </td>
                        <td className="text-right tabular-nums">{row.total}</td>
                        <td className="text-right tabular-nums">{row.vacant}</td>
                        <td className="text-right tabular-nums">
                          {row.rate.toFixed(0)}%
                        </td>
                        {seeIncome ? (
                          <td className="text-right tabular-nums">
                            {money(row.contracted)}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>No locations yet.</EmptyState>
            )}
          </Card>
          ) : null,

          "postdated-cheques": seeCheques ? (
          <Card
            title="Postdated cheques"
            description="Cheques held on file, their maturity dates and where each one has got to."
            action={
              <Link href="/payments/pdc" className="btn btn-secondary btn-sm">
                Cheque register
              </Link>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <StatTile
                label="On hand"
                value={money(pdcOnHandValue)}
                hint={`${pdcOnHand.length} cheque(s)`}
                tone="money"
                href="/payments/pdc?view=onhand"
              />
              <StatTile
                label="Maturing in 30 days"
                value={pdcMaturingSoon.length}
                hint="Prepare a deposit slip"
                href="/payments/pdc?view=maturing"
              />
              <StatTile
                label="Past maturity"
                value={pdcPastMaturity.length}
                hint="Not yet deposited"
                href="/payments/pdc?view=due"
              />
              <StatTile
                label="Bounced"
                value={pdcBounced.length}
                hint="Needs follow-up"
                href="/payments/pdc?view=bounced"
              />
            </div>
          </Card>
          ) : null,

          "billing-turnaround": seeTurnaround ? (
            <Card
              title="Billing turnaround"
              description={
                averageLag === null
                  ? "How long a utility period waits before it is billed."
                  : `On average ${averageLag} day${averageLag === 1 ? "" : "s"} from keying a utility period in to generating the invoice.`
              }
              bodyClassName=""
            >
              {turnaroundRows.length > 0 ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-3 px-5 py-4">
                    <StatTile
                      label="Average turnaround"
                      value={
                        averageLag === null
                          ? "—"
                          : `${averageLag} day${averageLag === 1 ? "" : "s"}`
                      }
                      hint={`${billedPeriods.length} period(s) billed`}
                    />
                    <StatTile
                      label="Slowest"
                      value={
                        slowest
                          ? `${slowest.lag} day${slowest.lag === 1 ? "" : "s"}`
                          : "—"
                      }
                      hint={
                        slowest
                          ? `${slowest.location ?? "?"} · ${slowest.utility}`
                          : "Nothing billed yet"
                      }
                    />
                    <StatTile
                      label="Still unbilled"
                      value={waitingPeriods.length}
                      hint={
                        longestWait
                          ? `Longest waiting ${longestWait.waiting} day${longestWait.waiting === 1 ? "" : "s"}`
                          : "All periods billed"
                      }
                    />
                  </div>

                  {/* The ones still waiting lead: they are the only rows
                      anybody can still do something about. */}
                  {waitingPeriods.length > 0 ? (
                    <div className="table-scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Not yet billed</th>
                            <th>Period</th>
                            <th>Keyed in</th>
                            <th className="text-right">Waiting</th>
                          </tr>
                        </thead>
                        <tbody>
                          {waitingPeriods.slice(0, 6).map((row) => (
                            <tr key={row.id}>
                              <td className="text-sm">
                                {row.location ?? "—"} · {row.utility}
                              </td>
                              <td className="text-xs">
                                {formatDate(row.periodStart)} to{" "}
                                {formatDate(row.periodEnd)}
                              </td>
                              <td className="text-xs">{formatDate(row.entered)}</td>
                              <td
                                className="text-right tabular-nums text-sm"
                                style={{
                                  color:
                                    (row.waiting ?? 0) > 7
                                      ? "var(--danger)"
                                      : undefined,
                                }}
                              >
                                {row.waiting} day{row.waiting === 1 ? "" : "s"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {recentTurnaround.length > 0 ? (
                    <div className="table-scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Billed</th>
                            <th>Period</th>
                            <th>Keyed in</th>
                            <th>Invoiced</th>
                            <th className="text-right">Took</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recentTurnaround.map((row) => (
                            <tr key={row.id}>
                              <td className="text-sm">
                                {row.location ?? "—"} · {row.utility}
                              </td>
                              <td className="text-xs">
                                {formatDate(row.periodStart)} to{" "}
                                {formatDate(row.periodEnd)}
                              </td>
                              <td className="text-xs">{formatDate(row.entered)}</td>
                              <td className="text-xs">
                                {row.billedOn ? formatDate(row.billedOn) : "—"}
                              </td>
                              <td
                                className="text-right tabular-nums text-sm"
                                style={{
                                  color:
                                    (row.lag ?? 0) > 7
                                      ? "var(--danger)"
                                      : undefined,
                                }}
                              >
                                {row.lag === 0
                                  ? "same day"
                                  : `${row.lag} day${row.lag === 1 ? "" : "s"}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState>
                  No utility periods recorded yet, so there is nothing to time.
                </EmptyState>
              )}
            </Card>
          ) : null,
          "utility-usage": seeUtilities ? (
          <Card
            title="Utility usage"
            description="Provider consumption against what the sub-meters account for."
            bodyClassName=""
          >
            {periods && periods.length > 0 ? (
              <>
                <div className="card-body" style={{ paddingBottom: 0 }}>
                  <UtilityUsageChart points={utilityChartPoints} months={utilityMonths} />
                </div>

                <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Utility</th>
                      <th className="text-right">Rate</th>
                      {/* "Unbilled 2340" read as a quantity; now that a loss
                          is negative, the column is a variance, not a total. */}
                      <th className="text-right">Recovery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((period) => {
                      const tenantTotal = (period.meter_readings ?? []).reduce(
                        (sum, row) => sum + Number(row.consumption ?? 0),
                        0,
                      );
                      const check = reconcile(
                        Number(period.provider_consumption),
                        tenantTotal,
                      );
                      const rate = effectiveRate({
                        providerAmount: Number(period.provider_amount),
                        providerConsumption: Number(period.provider_consumption),
                        manualRate:
                          period.manual_rate === null
                            ? null
                            : Number(period.manual_rate),
                      });
                      return (
                        <tr key={period.id}>
                          <td className="text-xs">
                            <Link
                              href={`/billing/periods/${period.id}`}
                              style={{ color: "var(--color-brand-600)" }}
                            >
                              {formatDate(period.period_start)}
                            </Link>
                            <p className="muted">{period.locations?.code}</p>
                          </td>
                          <td>
                            <span className="badge">{period.utility}</span>
                          </td>
                          <td className="text-right tabular-nums">
                            {rate ? rate.toFixed(4) : "—"}
                          </td>
                          <td
                            className="text-right tabular-nums"
                            style={{
                              color:
                                Math.abs(check.percentage) > 15
                                  ? "var(--danger)"
                                  : undefined,
                            }}
                          >
                            {round3(check.difference)}
                            <p className="text-xs muted">{check.percentage}%</p>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            ) : (
              <EmptyState>No utility periods recorded yet.</EmptyState>
            )}
          </Card>
          ) : null,
        }}
      />
    </>
  );
}
