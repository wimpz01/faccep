import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { OccupancyDonut } from "@/components/occupancy-donut";
import { Card, EmptyState, PageHeader, StatTile, formatDateTime } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { derivedRate, reconcile, round3 } from "@/lib/billing";
import { formatDate, money, monthsUntil } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

/** Spec 3: warn two days before the due date, and once overdue. */
const DUE_SOON_DAYS = 2;
/** Spec 3: six months before a contract ends, to trigger the renewal notice. */
const RENEWAL_NOTICE_MONTHS = 6;
const PDC_HORIZON_DAYS = 30;

export default async function DashboardPage() {
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
  const monthStart = `${today.slice(0, 7)}-01`;

  const seeOccupancy = can(permissions, MODULE.dashboardOccupancy, "view");
  const seeIncome = can(permissions, MODULE.dashboardIncome, "view");
  const seeUtilities = can(permissions, MODULE.dashboardUtilities, "view");
  const seeNotifications = can(permissions, MODULE.dashboardNotifications, "view");
  const seeAudit = can(permissions, MODULE.adminAudit, "view");

  const [
    { data: locations },
    { data: openInvoices },
    { data: contracts },
    { data: cheques },
    { data: paymentsThisMonth },
    { data: periods },
    { data: activity },
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
            "id, invoice_no, due_date, total, amount_paid, credited_amount, tenants(company_name)",
          )
          .eq("company_id", companyId)
          .in("status", ["released", "partially_paid"])
          .order("due_date")
          .returns<
            {
              id: string;
              invoice_no: string;
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
            "id, utility, period_start, provider_amount, provider_consumption, locations(code), meter_readings(consumption)",
          )
          .eq("company_id", companyId)
          .order("period_start", { ascending: false })
          .limit(6)
          .returns<
            {
              id: string;
              utility: string;
              period_start: string;
              provider_amount: string;
              provider_consumption: string;
              locations: { code: string } | null;
              meter_readings: { consumption: string }[];
            }[]
          >()
      : Promise.resolve({ data: null }),
    seeAudit
      ? supabase
          .from("audit_log")
          .select("id, action, summary, actor_email, created_at")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .limit(6)
      : Promise.resolve({ data: null }),
  ]);

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

  const notificationCount =
    overdue.length + dueSoon.length + renewals.length + (cheques?.length ?? 0);

  return (
    <>
      <PageHeader
        title={context.activeCompany.companyName}
        description="Occupancy, receivables and what needs attention this week."
      />

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

      {seeOccupancy ? (
        <div className="mb-6">
          <Card title="Occupancy" description="Let against vacant, across every location.">
            <OccupancyDonut occupied={totalOccupied} vacant={totalVacant} />
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
        {seeIncome ? (
          <StatTile
            label="Collected this month"
            value={money(collected)}
            hint="Posted payments"
            tone="money"
          />
        ) : null}
        {can(permissions, MODULE.billingInvoices, "view") ? (
          <StatTile
            label="Receivables"
            value={money(receivables)}
            hint={`${withBalance.length} open invoice(s)`}
          />
        ) : null}
        {seeNotifications ? (
          <StatTile
            label="Needs attention"
            value={notificationCount}
            hint="Overdue, due soon, renewals, cheques"
          />
        ) : null}
      </div>

      {seeNotifications ? (
        <div className="mb-6">
          <Card
            title="Notifications"
            description="Overdue and near-due billings, contracts approaching renewal, and cheques nearing maturity."
            bodyClassName=""
          >
            {notificationCount > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
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
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {seeOccupancy ? (
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
        ) : null}

        {seeUtilities ? (
          <Card
            title="Utility usage"
            description="Provider consumption against what the sub-meters account for."
            bodyClassName=""
          >
            {periods && periods.length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Utility</th>
                      <th className="text-right">Rate</th>
                      <th className="text-right">Unbilled</th>
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
                      const rate = derivedRate(
                        Number(period.provider_amount),
                        Number(period.provider_consumption),
                      );
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
            ) : (
              <EmptyState>No utility periods recorded yet.</EmptyState>
            )}
          </Card>
        ) : null}

        {seeAudit ? (
          <Card
            title="Recent activity"
            action={
              <Link href="/admin/audit" className="btn btn-secondary btn-sm">
                View all
              </Link>
            }
            bodyClassName=""
          >
            {activity && activity.length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    {activity.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <p className="text-sm">{entry.summary}</p>
                          <p className="text-xs muted">
                            {entry.actor_email} · {formatDateTime(entry.created_at)}
                          </p>
                        </td>
                        <td className="text-right">
                          <span className="badge">{entry.action}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState>No activity recorded yet.</EmptyState>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}
