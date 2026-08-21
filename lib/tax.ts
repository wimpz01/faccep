/**
 * Tax rates, read from the company's settings rather than written into code.
 *
 * The rates themselves live in the tax_rates table so they can be edited when
 * the BIR revises them. This module only knows how a rate is applied.
 *
 * The mirror of this is suggested_tenant_withholding() in the database, which
 * states the same rule in SQL. db-verify checks the two agree, because the
 * whole reason this table exists is that the old arrangement had the same rate
 * written in two places with nothing keeping them equal.
 */

export type TaxRateKind = "supplier_withholding" | "tenant_withholding";

export type TaxRate = {
  id: string;
  kind: TaxRateKind;
  code: string;
  label: string;
  rate: number;
  atc: string | null;
  note: string | null;
  is_active: boolean;
  sort: number;
};

/** The rate for a code, or zero when the company has not set one. */
export function rateFor(rates: TaxRate[], kind: TaxRateKind, code: string) {
  const found = rates.find(
    (row) => row.kind === kind && row.code === code && row.is_active,
  );
  return found ? Number(found.rate) : 0;
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * What a withholding tenant would normally keep back from one invoice.
 *
 * The base is the VATable inclusions alone, net of VAT -- not the whole
 * invoice. A line that is exempt, zero-rated or outside VAT (a reimbursement
 * passed straight through, say) is not withheld on, and counting it would
 * withhold money that then has to be chased back from the BIR.
 *
 * On a 10,000 rent inclusive of 12% VAT the base is 8,928.57, so 5% is 446.43.
 *
 * A suggestion, never a rule. What gets recorded is what the tenant actually
 * withheld, which is what their remittance and their 2307 will show.
 */
export function suggestedWithholding({
  vatableNet,
  vatAmount,
  withholds,
  isGovernment,
  rates,
}: {
  /** Net of the VATable lines only, as stamped when the invoice was raised. */
  vatableNet: number;
  vatAmount: number;
  withholds: boolean;
  isGovernment: boolean;
  rates: TaxRate[];
}) {
  if (!withholds) return { tax: 0, vat: 0 };

  const tax = round2(
    (vatableNet * rateFor(rates, "tenant_withholding", "rental")) / 100,
  );

  // Only a government tenant withholds the VAT as well.
  const vat = isGovernment
    ? round2((vatAmount * rateFor(rates, "tenant_withholding", "government_vat")) / 100)
    : 0;

  return { tax, vat };
}

/** Supplier withholding rates keyed by kind, for the purchasing screens. */
export function supplierRateMap(rates: TaxRate[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rates) {
    if (row.kind === "supplier_withholding" && row.is_active) {
      map[row.code] = Number(row.rate);
    }
  }
  return map;
}
