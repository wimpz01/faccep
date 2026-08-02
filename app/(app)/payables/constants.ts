/** The four things a cheque voucher can be. */
export const VOUCHER_KINDS = [
  {
    value: "payment",
    label: "Payment",
    hint: "Settled today — cash, a dated cheque, or online.",
  },
  {
    value: "prepayment",
    label: "Prepayment",
    hint: "A postdated cheque handed over now, payable on its date.",
  },
  {
    value: "void",
    label: "Void payment",
    hint: "The payment did not proceed. Reverses a voucher already raised.",
  },
  {
    value: "refund",
    label: "Refunded payment",
    hint: "Paid, but the supplier could not supply and returned the money.",
  },
] as const;

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Cheque" },
  { value: "online", label: "Online transfer" },
] as const;

export type VoucherKind = (typeof VOUCHER_KINDS)[number]["value"];

export function voucherKindLabel(kind: string) {
  return VOUCHER_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** A reversal returns money rather than paying it out. */
export function isReversal(kind: string) {
  return kind === "void" || kind === "refund";
}

/** What is being bought, which sets the expanded withholding rate. */
export const CHARGE_KINDS = [
  { value: "none", label: "Not subject to withholding", rate: 0 },
  { value: "goods", label: "Goods — 1% withholding", rate: 1 },
  { value: "services", label: "Services — 2% withholding", rate: 2 },
] as const;

export type InvoiceTaxSplit = {
  gross: number;
  net: number;
  vat: number;
  withholding: number;
  total: number;
};

/**
 * Splits a VAT-inclusive figure the way a Philippine supplier invoice reads.
 *
 * A supplier quotes VAT-inclusive, so the base is backed out rather than added
 * on. Expanded withholding is computed on that base, and only arises where the
 * supplier is VAT-registered. This mirrors sync_supplier_invoice_totals() in
 * the database, which is what actually decides the stored figures -- this copy
 * only exists so the form can show the split as it is typed.
 */
export function splitInvoiceTax(
  gross: number,
  isVatable: boolean,
  chargeKind: string,
  vatRate = 12,
): InvoiceTaxSplit {
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const net =
    isVatable && vatRate > 0 ? round2(gross / (1 + vatRate / 100)) : gross;
  const vat = round2(gross - net);
  const rate = isVatable
    ? (CHARGE_KINDS.find((kind) => kind.value === chargeKind)?.rate ?? 0)
    : 0;
  const withholding = round2((net * rate) / 100);
  return { gross, net, vat, withholding, total: round2(net + vat - withholding) };
}
