/**
 * Utility and invoice arithmetic (spec 6).
 *
 * Kept pure and free of database access so the rules can be reasoned about --
 * and tested -- on their own.
 */

export type UtilityBillingType = "fixed" | "minimum_overage" | "consumption";

/**
 * Rate derived from the provider's actual bill for the period:
 * total pesos divided by total consumption for the whole building.
 *
 * Returns 0 rather than dividing by zero when a period has been opened but the
 * provider bill has not been entered yet.
 */
export function derivedRate(providerAmount: number, providerConsumption: number) {
  if (!providerConsumption || providerConsumption <= 0) return 0;
  return providerAmount / providerConsumption;
}

export type UtilityChargeInput = {
  consumption: number;
  rate: number;
  billingType: UtilityBillingType;
  fixedAmount?: number | null;
  minimumAmount?: number | null;
};

export type UtilityCharge = {
  amount: number;
  /** How the figure was arrived at, shown on the invoice line. */
  basis: string;
};

/** One tenant's charge for one utility, per their contract's billing type. */
export function utilityCharge({
  consumption,
  rate,
  billingType,
  fixedAmount,
  minimumAmount,
}: UtilityChargeInput): UtilityCharge {
  const metered = round2(consumption * rate);

  if (billingType === "fixed") {
    return {
      amount: round2(fixedAmount ?? 0),
      basis: "Fixed monthly charge",
    };
  }

  if (billingType === "minimum_overage") {
    const minimum = minimumAmount ?? 0;
    if (metered <= minimum) {
      return {
        amount: round2(minimum),
        basis: `Minimum charge (metered ${formatUnits(consumption)} = ${metered.toFixed(2)})`,
      };
    }
    return {
      amount: metered,
      basis: `${formatUnits(consumption)} x ${rate.toFixed(4)} (over the ${minimum.toFixed(2)} minimum)`,
    };
  }

  return {
    amount: metered,
    basis: `${formatUnits(consumption)} x ${rate.toFixed(4)}`,
  };
}

/**
 * Generator expense allocated pro-rata by the tenant's share of building kWh
 * (spec 6, confirmed decision).
 */
export function gensetShare(
  tenantConsumption: number,
  buildingConsumption: number,
  gensetExpense: number,
) {
  if (!buildingConsumption || buildingConsumption <= 0 || !gensetExpense) return 0;
  return round2((tenantConsumption / buildingConsumption) * gensetExpense);
}

/**
 * Late payment penalty: a percentage of the unpaid utility charges, applied
 * once the billing has been outstanding for more than a week (spec 6).
 */
export function latePenalty(
  unpaidUtilityAmount: number,
  penaltyRatePercent: number,
) {
  return round2(unpaidUtilityAmount * (penaltyRatePercent / 100));
}

export function isPenaltyDue(billingReceivedOn: string, asOf = new Date()) {
  const received = new Date(`${billingReceivedOn.slice(0, 10)}T00:00:00`);
  const days = (asOf.getTime() - received.getTime()) / 86_400_000;
  return days > 7;
}

/**
 * Building-level reconciliation (spec 6): what the provider charged for versus
 * what the sub-meters account for. The gap is system loss or unbilled usage.
 *
 * Signed so that a loss is negative. When the provider billed for more than
 * the meters caught, the difference is absorbed and never recovered from
 * anyone -- money out, so it reads below zero. When the meters read higher,
 * tenants were charged for more than the building was billed, which is money
 * in. Every screen that shows this figure follows the same rule, so a minus
 * sign always means the same thing.
 */
export function reconcile(
  providerConsumption: number,
  tenantConsumptionTotal: number,
) {
  const difference = tenantConsumptionTotal - providerConsumption;
  const percentage =
    providerConsumption > 0 ? (difference / providerConsumption) * 100 : 0;
  return {
    providerConsumption,
    tenantConsumptionTotal,
    difference: round3(difference),
    percentage: Math.round(percentage * 100) / 100,
  };
}

/** VAT applies only to VATable tenants, and only to the vatable lines. */
export function computeTotals(
  lines: { amount: number; isVatable: boolean }[],
  isVatable: boolean,
  vatRate = 12,
) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const vatBase = round2(
    lines.filter((line) => line.isVatable).reduce((sum, line) => sum + line.amount, 0),
  );
  const vatAmount = isVatable ? round2((vatBase * vatRate) / 100) : 0;
  return { subtotal, vatAmount, total: round2(subtotal + vatAmount) };
}

/** Rent for a contract year under its escalation rate (spec 4.1). */
export function rentForPeriod(
  baseRent: number,
  escalationRatePercent: number,
  contractStart: string,
  periodStart: string,
) {
  const start = new Date(`${contractStart.slice(0, 10)}T00:00:00`);
  const period = new Date(`${periodStart.slice(0, 10)}T00:00:00`);
  let years = period.getFullYear() - start.getFullYear();
  const beforeAnniversary =
    period.getMonth() < start.getMonth() ||
    (period.getMonth() === start.getMonth() && period.getDate() < start.getDate());
  if (beforeAnniversary) years -= 1;
  const yearIndex = Math.max(0, years);
  return round2(baseRent * Math.pow(1 + escalationRatePercent / 100, yearIndex));
}

export function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round3(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function formatUnits(value: number) {
  return `${round3(value)}`;
}

/** Due date from the contract's rent due day, within the billing month. */
export function dueDateFor(periodStart: string, rentDueDay: number) {
  const [year, month] = periodStart.slice(0, 10).split("-").map(Number);
  const day = Math.min(Math.max(rentDueDay, 1), 28);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function monthLabel(periodStart: string) {
  const [year, month] = periodStart.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric",
  });
}
