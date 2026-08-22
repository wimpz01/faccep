"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requestApproval } from "@/lib/approvals";
import { logAudit } from "@/lib/audit";
import { assertPermission, getSessionContext } from "@/lib/auth";
import {
  dueDateFor,
  effectiveRate,
  expenseShare,
  latePenalty,
  monthLabel,
  rentForPeriod,
  round2,
  taxedAmount,
  utilityCharge,
  type TaxTreatment,
  type UtilityBillingType,
  type VatMode,
} from "@/lib/billing";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { ALL_LOCATIONS } from "./constants";

export type ActionState = { error?: string; success?: string };

type NewLine = {
  line_kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  is_vatable: boolean;
  sort_order: number;
  /** Set on utility and expense-share lines, tying them to the provider bill. */
  utility_period_id?: string;
};

/**
 * Generates one draft invoice per active contract for the given month.
 *
 * Everything is derived: rent from the contract's escalation schedule, water
 * and electricity from the sub-meter readings and the period's derived rate,
 * each utility's building expense shared out by consumption, and penalties
 * from what is still unpaid on earlier invoices. Existing invoices for the
 * same contract and period are skipped rather than duplicated.
 */
export async function generateInvoices(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const periodStart = String(formData.get("period_start") ?? "").slice(0, 10);
  if (!periodStart) return { error: "Choose the billing month." };

  /*
   * Which properties to bill, checked here and not only in the form.
   * A request that names none is refused outright rather than falling through
   * to "no filter": billing everywhere has to be asked for by name, so that
   * an empty field can never quietly mean the whole portfolio.
   */
  const selected = [
    ...new Set(
      formData
        .getAll("location_ids")
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
  if (selected.length === 0) {
    return { error: "Choose a location to bill." };
  }
  const billEverywhere = selected.includes(ALL_LOCATIONS);

  const [year, month] = periodStart.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().slice(0, 10);

  const supabase = await createClient();

  /*
   * Resolved against the database either way. "All" is expanded here rather
   * than left as an absent filter, so the run works from a named list of
   * properties and can report on each of them by name afterwards. A specific
   * id is only trusted once it is shown to belong to this company.
   */
  let locationQuery = supabase
    .from("locations")
    .select("id, code, name")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (!billEverywhere) locationQuery = locationQuery.in("id", selected);

  const { data: chosenLocations } = await locationQuery
    .order("code")
    .returns<{ id: string; code: string; name: string }[]>();

  const locations = chosenLocations ?? [];
  if (locations.length === 0) {
    return {
      error: billEverywhere
        ? "There are no active locations to bill."
        : "That location is not part of this company.",
    };
  }
  const locationIds = locations.map((row) => row.id);
  const nameOf = new Map(locations.map((row) => [row.id, row.code]));

  /*
   * Only contracts holding a unit in one of the chosen properties. The inner
   * join is what does the scoping: without it PostgREST would return every
   * active contract and merely leave the embedded units empty for the ones
   * that do not match, which reads as "no units" rather than "not selected".
   */
  const { data: contracts } = await supabase
    .from("contracts")
    .select(
      `id, tenant_id, start_date, end_date, monthly_rent, escalation_rate,
       rent_due_day, penalty_rate,
       water_billing_type, water_fixed_amount, water_minimum_amount,
       electric_billing_type, electric_fixed_amount, electric_minimum_amount,
       tenants(company_name, is_vatable),
       contract_units!inner(unit_id, units!inner(id, code, location_id)),
       contract_inclusions(inclusion, label, amount, sort_order,
         tax_treatment, vat_mode)`,
    )
    .eq("company_id", companyId)
    .eq("status", "active")
    .lte("start_date", monthEnd)
    .gte("end_date", monthStart)
    .in("contract_units.units.location_id", locationIds)
    .returns<ContractForBilling[]>();

  if (!contracts || contracts.length === 0) {
    return {
      error: `No active contracts cover ${monthLabel(monthStart)} in ${locations
        .map((row) => row.code)
        .join(", ")}.`,
    };
  }

  // Utility periods covering the month, keyed by location and utility.
  const { data: periods } = await supabase
    .from("utility_periods")
    .select(
      "id, location_id, utility, provider_amount, provider_consumption, manual_rate, extra_expense, is_locked, locations(code)",
    )
    .eq("company_id", companyId)
    .in("location_id", locationIds)
    .lte("period_start", monthEnd)
    .gte("period_end", monthStart)
    .returns<UtilityPeriodRow[]>();

  const periodByKey = new Map(
    (periods ?? []).map((period) => [
      `${period.location_id}:${period.utility}`,
      period,
    ]),
  );

  // One rate per company, read once. Every line stamps the rate in force now,
  // so changing it later cannot restate an invoice already raised.
  const { data: taxSettings } = await supabase
    .from("accounting_settings")
    .select("vat_rate")
    .eq("company_id", companyId)
    .maybeSingle<{ vat_rate: string }>();
  const vatRate = Number(taxSettings?.vat_rate ?? 0);

  /**
   * Both utilities must be measured and declared final before anyone is
   * billed. A period that is still open can have its provider bill or its
   * readings changed, and a charge raised off figures that then move is a
   * re-billing. Locking is the declaration; nothing bills without it.
   *
   * The run is refused outright rather than part-completed, so the month is
   * never half billed.
   */
  const blockers: string[] = [];
  const locationsToBill = new Set<string>();
  for (const contract of contracts) {
    for (const link of contract.contract_units ?? []) {
      const location = link.units?.location_id;
      if (location && nameOf.has(location)) locationsToBill.add(location);
    }
  }

  const locationCode = nameOf;

  // A chosen property with nothing to bill is not a blocker -- it has no
  // utility period to demand -- but it is worth saying so rather than leaving
  // it out of the report altogether.
  const emptyLocations = locationIds.filter((id) => !locationsToBill.has(id));

  for (const locationId of locationsToBill) {
    for (const utility of ["electric", "water"] as const) {
      const period = periodByKey.get(`${locationId}:${utility}`);
      const label = utility === "electric" ? "electricity" : "water";
      const where = locationCode.get(locationId) ?? "That location";

      if (!period) {
        blockers.push(
          `${where} has no ${label} period covering ${monthLabel(monthStart)}. Open it and enter the provider bill and readings first.`,
        );
        continue;
      }
      if (!period.is_locked) {
        blockers.push(
          `${where}'s ${label} period for ${monthLabel(monthStart)} is still open. Lock it once the bill and readings are final — locking is what makes it billable.`,
        );
      }
    }
  }

  if (blockers.length > 0) {
    return { error: `Nothing was generated. ${blockers.join(" ")}` };
  }

  // A period charged to tenants is spent. Billing it again would charge the
  // same provider bill twice, so it is withheld from this run and said so.
  const periodIds = (periods ?? []).map((period) => period.id);
  const spentPeriods = new Set<string>();
  if (periodIds.length > 0) {
    const { data: billedLines } = await supabase
      .from("invoice_lines")
      .select("utility_period_id, invoices!inner(status)")
      .in("utility_period_id", periodIds)
      .neq("invoices.status", "cancelled")
      .returns<{ utility_period_id: string }[]>();

    for (const row of billedLines ?? []) {
      if (row.utility_period_id) spentPeriods.add(row.utility_period_id);
    }
  }

  const { data: readings } = periodIds.length
    ? await supabase
        .from("meter_readings")
        .select("unit_id, period_id, consumption")
        .in("period_id", periodIds)
    : { data: [] };

  const readingByKey = new Map(
    (readings ?? []).map((row) => [`${row.period_id}:${row.unit_id}`, row]),
  );

  // Building totals per period, needed to share out that period's expense.
  const buildingConsumption = new Map<string, number>();
  for (const row of readings ?? []) {
    buildingConsumption.set(
      row.period_id,
      (buildingConsumption.get(row.period_id) ?? 0) + Number(row.consumption ?? 0),
    );
  }

  const { data: existing } = await supabase
    .from("invoices")
    .select("contract_id")
    .eq("company_id", companyId)
    .eq("period_start", monthStart)
    .neq("status", "cancelled");

  const alreadyBilled = new Set(
    (existing ?? []).map((row) => row.contract_id).filter(Boolean),
  );

  // Outstanding utility charges from earlier invoices, for the late penalty.
  const { data: overdue } = await supabase
    .from("invoices")
    .select("id, tenant_id, due_date, total, amount_paid, credited_amount")
    .eq("company_id", companyId)
    .in("status", ["released", "partially_paid"])
    .lt("due_date", monthStart);

  const overdueByTenant = new Map<string, number>();
  for (const invoice of overdue ?? []) {
    const balance =
      Number(invoice.total) - Number(invoice.amount_paid) - Number(invoice.credited_amount);
    if (balance > 0) {
      overdueByTenant.set(
        invoice.tenant_id,
        (overdueByTenant.get(invoice.tenant_id) ?? 0) + balance,
      );
    }
  }

  let created = 0;
  let skipped = 0;
  const problems: string[] = [];
  // Counted per property, because that is how the run is now scoped and how
  // the person who asked for it will check the result.
  const tally = new Map<string, { created: number; skipped: number }>(
    locationIds.map((id) => [id, { created: 0, skipped: 0 }]),
  );
  const countFor = (id: string | null) =>
    id ? tally.get(id) : undefined;

  for (const contract of contracts) {
    /*
     * Which property this invoice is billed against, fixed here and written
     * onto the record. The inner join has already narrowed the contract's
     * units to the chosen properties, so the first is the right one; a
     * contract straddling two of them is refused rather than guessed at.
     */
    const contractLocations = [
      ...new Set(
        (contract.contract_units ?? [])
          .map((link) => link.units?.location_id)
          .filter((id): id is string => Boolean(id) && nameOf.has(id!)),
      ),
    ];
    if (contractLocations.length > 1) {
      problems.push(
        `${contract.tenants?.company_name ?? contract.id}: holds units in ${contractLocations
          .map((id) => nameOf.get(id))
          .join(" and ")}, so it cannot be billed to one property. Bill those separately.`,
      );
      continue;
    }
    const contractLocationId = contractLocations[0] ?? null;

    if (alreadyBilled.has(contract.id)) {
      skipped += 1;
      const counter = countFor(contractLocationId);
      if (counter) counter.skipped += 1;
      continue;
    }

    const isVatable = contract.tenants?.is_vatable ?? false;
    const inclusions = new Map(
      (contract.contract_inclusions ?? []).map((item) => [item.inclusion, item]),
    );
    const lines: NewLine[] = [];
    let order = 0;

    /*
     * Where a line's tax treatment comes from: the contract item it was raised
     * against. A metered utility takes its treatment from that utility's
     * inclusion, and the share of a building expense follows the utility it
     * belongs to. A penalty answers to no inclusion, so it stays as it has
     * always been billed -- VATable, exclusive.
     */
    const treatmentFor = (kind: string) => {
      const key =
        kind === "genset"
          ? "electricity"
          : kind === "water_expense"
            ? "water"
            : kind;
      const item = inclusions.get(key);
      const treatment = (item?.tax_treatment ?? "vatable") as TaxTreatment;
      return {
        treatment,
        mode: (item?.vat_mode ?? "exclusive") as VatMode,
      };
    };

    if (inclusions.has("rent")) {
      /*
       * The rent comes from the database rather than being recomputed here,
       * because an escalation can be waived and only the contract's own
       * decisions know that. Falling back to the formula would quietly bill a
       * rise somebody had agreed to hold.
       */
      const { data: decidedRent, error: rentError } = await supabase.rpc(
        "contract_rent_on",
        { p_contract: contract.id, p_on: monthStart },
      );
      if (rentError) {
        problems.push(
          `${contract.tenants?.company_name ?? contract.id}: could not work out the rent — ${rentError.message}`,
        );
        continue;
      }
      const rent = Number(decidedRent ?? 0);
      lines.push({
        line_kind: "rent",
        description: `Monthly rent — ${monthLabel(monthStart)}`,
        quantity: 1,
        unit_price: rent,
        amount: rent,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    for (const key of ["parking", "security_guard"] as const) {
      const inclusion = inclusions.get(key);
      if (!inclusion) continue;
      const amount = round2(Number(inclusion.amount ?? 0));
      lines.push({
        line_kind: key,
        description:
          key === "parking" ? "Parking" : "Security guard",
        quantity: 1,
        unit_price: amount,
        amount,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    const other = inclusions.get("other");
    if (other) {
      const amount = round2(Number(other.amount ?? 0));
      lines.push({
        line_kind: "other",
        description: other.label ?? "Other charge",
        quantity: 1,
        unit_price: amount,
        amount,
        is_vatable: isVatable,
        sort_order: order++,
      });
    }

    const units = (contract.contract_units ?? [])
      .map((link) => link.units)
      .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit));

    for (const utility of ["water", "electric"] as const) {
      const inclusionKey = utility === "water" ? "water" : "electricity";
      if (!inclusions.has(inclusionKey)) continue;

      const billingType = (
        utility === "water"
          ? contract.water_billing_type
          : contract.electric_billing_type
      ) as UtilityBillingType;

      const fixedAmount =
        utility === "water"
          ? contract.water_fixed_amount
          : contract.electric_fixed_amount;
      const minimumAmount =
        utility === "water"
          ? contract.water_minimum_amount
          : contract.electric_minimum_amount;

      // A fixed charge needs no meter at all.
      if (billingType === "fixed") {
        const charge = utilityCharge({
          consumption: 0,
          rate: 0,
          billingType,
          fixedAmount: fixedAmount === null ? null : Number(fixedAmount),
        });
        lines.push({
          line_kind: utility === "water" ? "water" : "electricity",
          description: `${utility === "water" ? "Water" : "Electricity"} — ${charge.basis}`,
          quantity: 1,
          unit_price: charge.amount,
          amount: charge.amount,
          is_vatable: isVatable,
          sort_order: order++,
        });
        continue;
      }

      let consumption = 0;
      let period: UtilityPeriodRow | undefined;
      let missingReading = false;

      for (const unit of units) {
        const found = periodByKey.get(`${unit.location_id}:${utility}`);
        if (!found) {
          missingReading = true;
          continue;
        }
        period = found;
        const reading = readingByKey.get(`${found.id}:${unit.id}`);
        if (!reading) {
          missingReading = true;
          continue;
        }
        consumption += Number(reading.consumption ?? 0);
      }

      if (!period) {
        problems.push(
          `${contract.tenants?.company_name}: no ${utility} period for their location.`,
        );
        continue;
      }
      if (spentPeriods.has(period.id)) {
        problems.push(
          `${contract.tenants?.company_name}: the ${utility} period for their location has already been billed and is locked, so no ${utility} was charged.`,
        );
        continue;
      }
      if (missingReading) {
        problems.push(
          `${contract.tenants?.company_name}: missing ${utility} reading for one or more units.`,
        );
      }

      // What the period charges, which is its own rate where one was set.
      const rate = effectiveRate({
        providerAmount: Number(period.provider_amount),
        providerConsumption: Number(period.provider_consumption),
        manualRate:
          period.manual_rate === null ? null : Number(period.manual_rate),
      });

      const charge = utilityCharge({
        consumption,
        rate,
        billingType,
        fixedAmount: fixedAmount === null ? null : Number(fixedAmount),
        minimumAmount: minimumAmount === null ? null : Number(minimumAmount),
      });

      lines.push({
        line_kind: utility === "water" ? "water" : "electricity",
        description: `${utility === "water" ? "Water" : "Electricity"} — ${charge.basis}`,
        quantity: round2(consumption),
        unit_price: rate,
        amount: charge.amount,
        is_vatable: isVatable,
        sort_order: order++,
        utility_period_id: period.id,
      });

      /*
       * The building's own cost for this period, shared out by what each
       * tenant consumed (spec 6). On electricity that is the generator; on
       * water it is pumping, tanks and treatment. The same split either way,
       * and a line of its own so a tenant can tell what they used apart from
       * what they are carrying a share of.
       */
      if (Number(period.extra_expense) > 0) {
        const total = buildingConsumption.get(period.id) ?? 0;
        const share = expenseShare(
          consumption,
          total,
          Number(period.extra_expense),
        );
        if (share > 0) {
          const isWater = utility === "water";
          lines.push({
            line_kind: isWater ? "water_expense" : "genset",
            description: isWater
              ? `Water expense share — ${round2(consumption)} of ${round2(total)} cu.m`
              : `Generator expense share — ${round2(consumption)} of ${round2(total)} kWh`,
            quantity: 1,
            unit_price: share,
            amount: share,
            is_vatable: isVatable,
            sort_order: order++,
            utility_period_id: period.id,
          });
        }
      }
    }

    // 2% on what is still outstanding from earlier billings (spec 6).
    const outstanding = overdueByTenant.get(contract.tenant_id) ?? 0;
    if (outstanding > 0) {
      const penalty = latePenalty(outstanding, Number(contract.penalty_rate));
      if (penalty > 0) {
        lines.push({
          line_kind: "penalty",
          description: `Late payment penalty — ${Number(contract.penalty_rate)}% of ${outstanding.toFixed(2)} outstanding`,
          quantity: 1,
          unit_price: penalty,
          amount: penalty,
          is_vatable: false,
          sort_order: order++,
        });
      }
    }

    if (lines.length === 0) {
      problems.push(
        `${contract.tenants?.company_name}: no billable inclusions on the contract.`,
      );
      continue;
    }

    const { data: invoice, error } = await supabase
      .from("invoices")
      .insert({
        company_id: companyId,
        tenant_id: contract.tenant_id,
        contract_id: contract.id,
        // Written once. The number the trigger issues follows from it.
        location_id: contractLocationId,
        invoice_date: monthStart,
        due_date: dueDateFor(monthStart, contract.rent_due_day),
        period_start: monthStart,
        period_end: monthEnd,
        is_vatable: isVatable,
      })
      .select("id")
      .single();

    if (error) {
      problems.push(`${contract.tenants?.company_name}: ${error.message}`);
      continue;
    }

    const { error: lineError } = await supabase
      .from("invoice_lines")
      .insert(
        // Each line taxed on its own terms, never off the invoice total.
        lines.map((line) => {
          const { treatment, mode } = treatmentFor(line.line_kind);
          const taxed = taxedAmount({
            amount: line.amount,
            treatment,
            mode,
            vatRate,
            tenantIsVatable: isVatable,
          });
          return {
            invoice_id: invoice.id,
            ...line,
            tax_treatment: treatment,
            vat_mode: treatment === "vatable" ? mode : null,
            vat_rate: taxed.rate,
            net_amount: taxed.net,
            vat_amount: taxed.vat,
            line_total: taxed.total,
            is_vatable: taxed.vat > 0,
          };
        }),
      );

    if (lineError) {
      problems.push(`${contract.tenants?.company_name}: ${lineError.message}`);
      continue;
    }

    created += 1;
    const counter = countFor(contractLocationId);
    if (counter) counter.created += 1;
  }

  // Per property: what was raised, and where nothing was, why.
  const perLocation = locationIds.map((id) => {
    const code = nameOf.get(id) ?? "That location";
    const counter = tally.get(id) ?? { created: 0, skipped: 0 };
    if (counter.created > 0) {
      return `${code}: ${counter.created} draft${counter.created === 1 ? "" : "s"}${
        counter.skipped ? ` (${counter.skipped} already billed)` : ""
      }`;
    }
    if (counter.skipped > 0) {
      return `${code}: nothing new — all ${counter.skipped} already billed for this month`;
    }
    if (emptyLocations.includes(id)) {
      return `${code}: nothing — no active contract covers ${monthLabel(monthStart)}`;
    }
    return `${code}: nothing raised — see the notes below`;
  });

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    summary: `Generated ${created} draft invoice(s) for ${monthLabel(monthStart)} in ${locations
      .map((row) => row.code)
      .join(", ")}.`,
    after: { created, skipped, perLocation, problems },
  });

  revalidatePath("/billing/invoices");

  if (created === 0) {
    return {
      error:
        `Nothing was generated. ${perLocation.join(" · ")}` +
        (problems.length ? ` ${problems.join(" ")}` : ""),
    };
  }

  return {
    success:
      `${perLocation.join(" · ")}.` +
      (problems.length ? ` Check: ${problems.join(" ")}` : ""),
  };
}

type UtilityPeriodRow = {
  id: string;
  location_id: string;
  utility: string;
  provider_amount: string;
  provider_consumption: string;
  manual_rate: string | null;
  extra_expense: string;
  is_locked: boolean;
  locations: { code: string } | null;
};

type ContractForBilling = {
  id: string;
  tenant_id: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  escalation_rate: string;
  rent_due_day: number;
  penalty_rate: string;
  water_billing_type: string;
  water_fixed_amount: string | null;
  water_minimum_amount: string | null;
  electric_billing_type: string;
  electric_fixed_amount: string | null;
  electric_minimum_amount: string | null;
  tenants: { company_name: string; is_vatable: boolean } | null;
  contract_units: {
    unit_id: string;
    units: { id: string; code: string; location_id: string } | null;
  }[];
  contract_inclusions: {
    inclusion: string;
    label: string | null;
    amount: string | null;
    sort_order: number;
    tax_treatment: TaxTreatment;
    vat_mode: VatMode | null;
  }[];
};

/** Draft -> released. After this the invoice is immutable. */
export async function releaseInvoice(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status, total")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status !== "draft") return { error: "Only a draft can be released." };
  if (Number(invoice.total) <= 0) {
    return { error: "This invoice totals zero. Add lines before releasing it." };
  }

  const { error } = await supabase
    .from("invoices")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: error.message };

  await logAudit({
    action: "approve",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    summary: `Released invoice ${invoice.invoice_no}. It is now locked.`,
    before: { status: "draft" },
    after: { status: "released" },
  });

  revalidatePath(`/billing/invoices/${id}`);
  revalidatePath("/billing/invoices");
  return { success: "Released. The invoice can no longer be edited." };
}

/**
 * Releases several drafts in one go.
 *
 * Releasing posts to the ledger and locks the invoice, so each one is checked
 * on its own terms rather than trusted from the form: anything already
 * released, cancelled or totalling zero is skipped and reported, and the rest
 * still go out. A month's billing is usually released together, and doing it
 * one row at a time invites half a run.
 */
export async function releaseInvoices(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "approve");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const ids = formData
    .getAll("ids")
    .map((value) => String(value))
    .filter(Boolean);

  if (ids.length === 0) return { error: "Tick the invoices to release." };

  const supabase = await createClient();
  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, invoice_no, status, total")
    .in("id", ids)
    .returns<
      { id: string; invoice_no: string; status: string; total: string }[]
    >();

  const releasable = (invoices ?? []).filter(
    (invoice) => invoice.status === "draft" && Number(invoice.total) > 0,
  );
  const skipped = (invoices ?? []).filter(
    (invoice) => !releasable.some((row) => row.id === invoice.id),
  );

  if (releasable.length === 0) {
    return {
      error:
        "None of those can be released. Only a draft with a value above zero can go out.",
    };
  }

  const releasedAt = new Date().toISOString();
  const done: string[] = [];
  const failed: string[] = [];

  // One at a time: each release fires the posting trigger, and a failure on
  // one invoice must not silently take the others down with it.
  for (const invoice of releasable) {
    const { error } = await supabase
      .from("invoices")
      .update({ status: "released", released_at: releasedAt })
      .eq("id", invoice.id)
      .eq("status", "draft");

    if (error) {
      failed.push(`${invoice.invoice_no} (${error.message})`);
      continue;
    }
    done.push(invoice.invoice_no);

    await logAudit({
      action: "approve",
      moduleKey: MODULE.billingInvoices,
      entityTable: "invoices",
      entityId: invoice.id,
      summary: `Released invoice ${invoice.invoice_no} in a batch of ${releasable.length}. It is now locked.`,
      before: { status: "draft" },
      after: { status: "released" },
    });
  }

  revalidatePath("/billing/invoices");

  const notes: string[] = [];
  if (done.length > 0) {
    notes.push(`Released ${done.length} invoice(s): ${done.join(", ")}.`);
  }
  if (skipped.length > 0) {
    notes.push(
      `Skipped ${skipped.length}: ${skipped
        .map((row) => `${row.invoice_no} is ${row.status}`)
        .join(", ")}.`,
    );
  }
  if (failed.length > 0) {
    return { error: [`Could not release ${failed.join("; ")}.`, ...notes].join(" ") };
  }

  return { success: notes.join(" ") };
}

/** Cancellation is approval-gated (spec 2). */
export async function requestInvoiceCancellation(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for the cancellation." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status === "cancelled") return { error: "Already cancelled." };
  if (invoice.status === "draft") {
    return { error: "A draft is not released yet — delete it instead." };
  }

  const failure = await requestApproval({
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    action: "cancel",
    reason,
    summary: `invoice ${invoice.invoice_no}`,
  });
  if (failure) return { error: failure };

  revalidatePath(`/billing/invoices/${id}`);
  return { success: "Cancellation requested. It takes effect once approved." };
}

export async function createCreditMemo(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingCreditMemos, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const invoiceId = String(formData.get("invoice_id") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Enter the amount to credit." };
  }
  if (!reason) return { error: "Give a reason for the credit memo." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, total, credited_amount, status")
    .eq("id", invoiceId)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status === "draft") {
    return { error: "Edit the draft directly rather than crediting it." };
  }

  const remaining = Number(invoice.total) - Number(invoice.credited_amount);
  if (amount > remaining) {
    return {
      error: `That exceeds the uncredited balance of ${remaining.toFixed(2)}.`,
    };
  }

  const { data: memo, error } = await supabase
    .from("credit_memos")
    .insert({
      company_id: companyId,
      invoice_id: invoiceId,
      amount,
      reason,
    })
    .select("id, memo_no")
    .single();

  if (error) return { error: error.message };

  await logAudit({
    action: "create",
    moduleKey: MODULE.billingCreditMemos,
    entityTable: "credit_memos",
    entityId: memo.id,
    summary: `Issued ${memo.memo_no} for ${amount.toFixed(2)} against invoice ${invoice.invoice_no}: ${reason}`,
    after: { amount, reason },
  });

  revalidatePath(`/billing/invoices/${invoiceId}`);
  return { success: `Credit memo ${memo.memo_no} issued.` };
}

/**
 * Cancels a draft that will not proceed.
 *
 * No approval is needed — a draft never reached the ledger — but the document
 * and its lines are kept exactly as they were, with the reason recorded.
 * Nothing is deleted.
 */
export async function cancelDraftInvoice(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await assertPermission(MODULE.billingInvoices, "edit");
  } catch (error) {
    return { error: (error as Error).message };
  }

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "Give a reason for cancelling it." };

  const supabase = await createClient();
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_no, status")
    .eq("id", id)
    .single();

  if (!invoice) return { error: "Invoice not found." };
  if (invoice.status !== "draft") {
    return {
      error:
        "Only a draft can be cancelled outright. A released invoice needs an approved cancellation.",
    };
  }

  const { error } = await supabase
    .from("invoices")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoices",
    entityId: id,
    summary: `Cancelled draft invoice ${invoice.invoice_no}: ${reason}`,
    before: { status: "draft" },
    after: { status: "cancelled", reason },
  });

  revalidatePath(`/billing/invoices/${id}`);
  revalidatePath("/billing/invoices");
  return { success: "Cancelled. The record is kept for the trail." };
}

/**
 * Saves how a billing is laid out when printed.
 *
 * Affects the sheet only. No invoice is touched, nothing is recomputed, and a
 * billing already issued prints under whatever layout is current -- which is
 * the point: the paper changes, the money does not.
 */
export async function updateInvoicePrintLayout(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const number = (field: string, low: number, high: number, label: string) => {
    const value = Number(formData.get(field));
    if (!Number.isFinite(value) || value < low || value > high) {
      return { error: `${label} must be between ${low} and ${high}.` };
    }
    return { value };
  };

  const width = number("page_width_in", 3, 24, "Page width");
  if ("error" in width) return { error: width.error };
  const height = number("page_height_in", 3, 24, "Page height");
  if ("error" in height) return { error: height.error };
  const margin = number("margin_in", 0, 2, "Margin");
  if ("error" in margin) return { error: margin.error };
  const body = number("body_font_pt", 5, 16, "Body type size");
  if ("error" in body) return { error: body.error };
  const table = number("table_font_pt", 5, 16, "Table type size");
  if ("error" in table) return { error: table.error };

  const note = String(formData.get("footer_note") ?? "").trim();

  const row = {
    page_width_in: width.value,
    page_height_in: height.value,
    margin_in: margin.value,
    body_font_pt: body.value,
    table_font_pt: table.value,
    // An unticked box sends nothing at all, which is what makes it false.
    show_logo: formData.get("show_logo") !== null,
    show_company_header: formData.get("show_company_header") !== null,
    show_meter_columns: formData.get("show_meter_columns") !== null,
    show_meter_dates: formData.get("show_meter_dates") !== null,
    show_vat_column: formData.get("show_vat_column") !== null,
    show_payment_note: formData.get("show_payment_note") !== null,
    show_signatures: formData.get("show_signatures") !== null,
    footer_note: note === "" ? null : note,
  };

  const supabase = await createClient();
  const { error } = await supabase
    .from("invoice_print_settings")
    .upsert({ company_id: companyId, ...row }, { onConflict: "company_id" });
  if (error) return { error: error.message };

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingInvoices,
    entityTable: "invoice_print_settings",
    entityId: companyId,
    summary: `Billing print layout set to ${row.page_width_in}in x ${row.page_height_in}in.`,
    after: row,
  });

  revalidatePath("/billing/invoices/print-layout");
  revalidatePath("/billing/invoices");
  return {
    success: `Saved. Billings now print on ${row.page_width_in}in x ${row.page_height_in}in.`,
  };
}

/**
 * Points the company at a newly uploaded logo, and clears away the one before.
 *
 * The file is already in storage by the time this runs -- the browser puts it
 * there directly -- so this records where it went and removes the previous
 * mark, which nothing would otherwise ever delete.
 */
export async function setCompanyLogo(path: string) {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  // The path is built by the browser, so it is checked rather than trusted:
  // one company must not be able to point at another's folder.
  if (!path.startsWith(`${companyId}/branding/`)) {
    return { error: "That file does not belong to this company." };
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("companies")
    .select("logo_path")
    .eq("id", companyId)
    .maybeSingle<{ logo_path: string | null }>();

  const { error } = await supabase
    .from("companies")
    .update({ logo_path: path })
    .eq("id", companyId);
  if (error) return { error: error.message };

  if (before?.logo_path && before.logo_path !== path) {
    await supabase.storage.from("documents").remove([before.logo_path]);
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingInvoices,
    entityTable: "companies",
    entityId: companyId,
    summary: "Set the company logo shown on printed documents.",
    before: { logo_path: before?.logo_path ?? null },
    after: { logo_path: path },
  });

  revalidatePath("/billing/invoices/print-layout");
  revalidatePath("/billing/invoices");
  return {};
}

/** Takes the logo off the documents, and out of storage with it. */
export async function clearCompanyLogo() {
  let companyId: string;
  try {
    const context = await assertPermission(MODULE.billingInvoices, "edit");
    companyId = context.activeCompany!.companyId;
  } catch (error) {
    return { error: (error as Error).message };
  }

  const supabase = await createClient();
  const { data: before } = await supabase
    .from("companies")
    .select("logo_path")
    .eq("id", companyId)
    .maybeSingle<{ logo_path: string | null }>();

  const { error } = await supabase
    .from("companies")
    .update({ logo_path: null })
    .eq("id", companyId);
  if (error) return { error: error.message };

  if (before?.logo_path) {
    await supabase.storage.from("documents").remove([before.logo_path]);
  }

  await logAudit({
    action: "update",
    moduleKey: MODULE.billingInvoices,
    entityTable: "companies",
    entityId: companyId,
    summary: "Removed the company logo from printed documents.",
    before: { logo_path: before?.logo_path ?? null },
    after: { logo_path: null },
  });

  revalidatePath("/billing/invoices/print-layout");
  revalidatePath("/billing/invoices");
  return {};
}
