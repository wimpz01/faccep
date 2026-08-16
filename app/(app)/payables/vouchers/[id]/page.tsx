import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  attachInvoicesToVoucher,
  cancelVoucher,
  releaseVoucher,
  submitVoucherForApproval,
} from "../../actions";
import { voucherKindLabel } from "../../constants";
import {
  AttachInvoicesForm,
  VoucherRowActions,
  type OpenBill,
} from "../../payables-forms";
import { PrintButton } from "@/components/print-button";

export const metadata: Metadata = { title: "Voucher" };

type VoucherDetail = {
  id: string;
  company_id: string;
  vendor_id: string;
  voucher_no: string;
  voucher_date: string;
  amount: string;
  check_no: string | null;
  bank: string | null;
  check_date: string | null;
  status: string;
  voucher_kind: string;
  payment_method: string | null;
  withholding_tax: string;
  notes: string | null;
  released_at: string | null;
  vendors: {
    name: string;
    vendor_no: string;
    tin: string | null;
    address: string | null;
  } | null;
  voucher_lines: {
    id: string;
    amount: string;
    supplier_invoice_id: string;
    supplier_invoices: {
      bill_no: string;
      invoice_no: string;
      invoice_date: string;
      amount: string;
      vat_amount: string;
      withholding_tax: string;
      total: string;
    } | null;
  }[];
};

/** Words on a cheque voucher, the way a cheque is written out. */
function inWords(value: number): string {
  const ones = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety",
  ];

  function under1000(n: number): string {
    if (n < 20) return ones[n];
    if (n < 100) {
      return tens[Math.floor(n / 10)] + (n % 10 ? `-${ones[n % 10]}` : "");
    }
    return `${ones[Math.floor(n / 100)]} hundred${n % 100 ? ` ${under1000(n % 100)}` : ""}`;
  }

  const whole = Math.floor(value);
  const centavos = Math.round((value - whole) * 100);

  const parts: string[] = [];
  const scales: [number, string][] = [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"],
  ];

  let left = whole;
  for (const [size, name] of scales) {
    if (left >= size) {
      parts.push(`${under1000(Math.floor(left / size))} ${name}`);
      left %= size;
    }
  }
  if (left > 0 || parts.length === 0) parts.push(under1000(left));

  const pesos = parts.join(" ");
  const tail = centavos > 0 ? ` and ${centavos}/100` : " only";
  return `${pesos.charAt(0).toUpperCase()}${pesos.slice(1)} pesos${tail}`;
}

export default async function VoucherDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payablesVouchers, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const [{ data: voucher }, { data: company }] = await Promise.all([
    supabase
      .from("check_vouchers")
      .select(
        `id, company_id, vendor_id, voucher_no, voucher_date, amount, check_no, bank,
         check_date, status, voucher_kind, payment_method, withholding_tax,
         notes, released_at,
         vendors(name, vendor_no, tin, address),
         voucher_lines(id, amount, supplier_invoice_id,
           supplier_invoices(bill_no, invoice_no, invoice_date, amount, vat_amount, withholding_tax, total))`,
      )
      .eq("id", id)
      .maybeSingle<VoucherDetail>(),
    supabase
      .from("companies")
      .select("name, legal_name, address, tin")
      .eq("id", companyId)
      .single(),
  ]);

  if (!voucher || voucher.company_id !== companyId) notFound();

  const lines = voucher.voucher_lines ?? [];
  const applied = lines.reduce((sum, line) => sum + Number(line.amount), 0);
  const amount = Number(voucher.amount);
  const withheld = Number(voucher.withholding_tax ?? 0);

  /*
   * Tax is usually withheld when the bill is recorded, not when the cheque is
   * cut, so the voucher's own withholding is nil and the cheque simply reads
   * short of the supplier's invoice. Carrying the bills' figures onto the
   * voucher lets it show the sum billed and the tax held back against it --
   * which is what the supplier is querying when the cheque does not match
   * their invoice.
   *
   * Pro-rated, so a voucher settling half a bill claims half its withholding
   * rather than all of it.
   */
  const settled = lines.reduce(
    (totals, line) => {
      const bill = line.supplier_invoices;
      if (!bill) return totals;
      const billTotal = Number(bill.total) || 0;
      const share = billTotal > 0 ? Number(line.amount) / billTotal : 0;
      return {
        gross:
          totals.gross +
          (Number(bill.amount) + Number(bill.vat_amount)) * share,
        withheld: totals.withheld + Number(bill.withholding_tax) * share,
      };
    },
    { gross: 0, withheld: 0 },
  );
  const withheldOnBills = round2(settled.withheld);
  const grossSettled = round2(settled.gross);

  const canPrepare = can(context.permissions, MODULE.payablesVouchers, "edit");
  const canRelease = can(context.permissions, MODULE.payablesPayments, "approve");

  // A cheque still in draft can have its invoices matched to it. Its own lines
  // pre-fill the form; they are not in amount_paid, because settlement only
  // counts released vouchers.
  const attached: Record<string, number> = {};
  for (const line of lines) {
    attached[line.supplier_invoice_id] =
      (attached[line.supplier_invoice_id] ?? 0) + Number(line.amount);
  }

  let openBills: OpenBill[] = [];
  if (voucher.status === "draft" && canPrepare) {
    const { data: bills } = await supabase
      .from("supplier_invoices")
      .select(
        "id, invoice_no, due_date, amount, vat_amount, withholding_tax, total, amount_paid, status, maintenance_jobs(job_no)",
      )
      .eq("company_id", companyId)
      .eq("vendor_id", voucher.vendor_id)
      .in("status", ["open", "partially_paid"])
      .order("due_date");

    openBills = (bills ?? [])
      .map((bill) => {
        const row = bill as unknown as {
          id: string;
          invoice_no: string;
          due_date: string;
          amount: string;
          vat_amount: string;
          withholding_tax: string;
          total: string;
          amount_paid: string;
          maintenance_jobs: { job_no: string } | null;
        };
        const gross = Number(row.amount) + Number(row.vat_amount);
        return {
          id: row.id,
          invoice_no: row.invoice_no,
          vendor_id: voucher.vendor_id,
          due_date: row.due_date,
          outstanding: round2(Number(row.total) - Number(row.amount_paid)),
          jobNo: row.maintenance_jobs?.job_no ?? null,
          netShare: gross > 0 ? Number(row.amount) / gross : 1,
          alreadyWithheld: Number(row.withholding_tax) > 0,
        };
      })
      .filter((bill) => bill.outstanding > 0);
  }

  const { data: pending } = await supabase
    .from("approval_requests")
    .select("id")
    .eq("entity_table", "check_vouchers")
    .eq("entity_id", voucher.id)
    .eq("status", "pending")
    .maybeSingle();

  return (
    <>
      <div className="no-print flex items-center justify-between gap-3 flex-wrap mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            {voucher.voucher_no}
          </h1>
          <p className="text-sm muted mt-0.5">
            {voucherKindLabel(voucher.voucher_kind)} · {voucher.status}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/payables?tab=vouchers" className="btn btn-secondary btn-sm">
            Back to vouchers
          </Link>
          {/* Only where tax was actually held back is there anything to
              certify. */}
          {withheldOnBills > 0 || withheld > 0 ? (
            <Link
              href={`/payables/vouchers/${voucher.id}/form-2307`}
              className="btn btn-secondary btn-sm"
            >
              BIR Form 2307
            </Link>
          ) : null}
          <PrintButton />
        </div>
      </div>

      <div className="no-print grid gap-4 mb-5">
        {voucher.status === "draft" && canPrepare && !pending ? (
          <Card
            title="Match invoices to this cheque"
            description={
              voucher.voucher_kind === "prepayment"
                ? "A postdated cheque is written first and matched to the bills it settles before it is released."
                : "Change what this voucher pays while it is still a draft."
            }
          >
            <AttachInvoicesForm
              action={attachInvoicesToVoucher}
              voucherId={voucher.id}
              voucherNo={voucher.voucher_no}
              faceAmount={amount}
              bills={openBills}
              attached={attached}
            />
          </Card>
        ) : null}

        {canPrepare || canRelease ? (
          <Card title="Where this voucher stands">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm muted">
                {voucher.status === "released"
                  ? "Released and posted to the general ledger."
                  : pending
                    ? "Sitting in the approval queue. It posts once it is signed off."
                    : voucher.status === "approved"
                      ? "Approved. Release it to post it to the ledger."
                      : voucher.status === "cancelled"
                        ? "Cancelled; it will not proceed."
                        : "Draft. Nothing has been posted yet."}
              </p>
              <VoucherRowActions
                voucherId={voucher.id}
                status={voucher.status}
                kind={voucher.voucher_kind}
                hasLines={lines.length > 0}
                awaitingApproval={Boolean(pending)}
                canPrepare={canPrepare}
                canRelease={canRelease}
                showAttachLink={false}
                submitAction={submitVoucherForApproval}
                releaseAction={releaseVoucher}
                cancelAction={cancelVoucher}
              />
            </div>
          </Card>
        ) : null}
      </div>

      <div className="doc-sheet">
        <p style={{ textAlign: "center", marginBottom: "0.25rem" }}>
          <strong>{company?.legal_name ?? company?.name}</strong>
          {company?.address ? (
            <>
              <br />
              {company.address}
            </>
          ) : null}
          {company?.tin ? (
            <>
              <br />
              TIN {company.tin}
            </>
          ) : null}
        </p>

        <h1>
          {voucher.voucher_kind === "prepayment"
            ? "Cheque Voucher — Postdated"
            : voucher.voucher_kind === "payment"
              ? "Cheque Voucher"
              : `Cheque Voucher — ${voucherKindLabel(voucher.voucher_kind)}`}
        </h1>

        <table>
          <tbody>
            <tr>
              <th style={{ width: "22%" }}>Voucher no.</th>
              <td style={{ width: "28%" }}>{voucher.voucher_no}</td>
              <th style={{ width: "22%" }}>Date</th>
              <td>{formatDate(voucher.voucher_date)}</td>
            </tr>
            <tr>
              <th>Pay to</th>
              <td>{voucher.vendors?.name ?? "—"}</td>
              <th>Supplier code</th>
              <td>{voucher.vendors?.vendor_no ?? "—"}</td>
            </tr>
            <tr>
              <th>TIN</th>
              <td>{voucher.vendors?.tin ?? "—"}</td>
              <th>Paid by</th>
              <td>{voucher.payment_method ?? "—"}</td>
            </tr>
            {/* A cheque voucher shows these whether or not they have been
                filled in: blank tells whoever holds the paper that the cheque
                has not been written yet, which hiding the row does not. Cash
                and transfers keep it out of the way. */}
            {voucher.payment_method === "check" ||
            voucher.check_no ||
            voucher.bank ||
            voucher.check_date ? (
              <tr>
                <th>Cheque no.</th>
                <td>{voucher.check_no || "—"}</td>
                <th>
                  {voucher.voucher_kind === "prepayment"
                    ? "Matures"
                    : "Cheque date"}
                </th>
                <td>
                  {voucher.check_date ? formatDate(voucher.check_date) : "—"}
                  {voucher.bank ? ` · ${voucher.bank}` : ""}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <h2>Settles</h2>
        <table>
          <thead>
            <tr>
              <th>Bill</th>
              <th>Supplier&rsquo;s invoice</th>
              <th>Invoice date</th>
              <th style={{ textAlign: "right" }}>Document total</th>
              <th style={{ textAlign: "right" }}>Payment amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length > 0 ? (
              lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.supplier_invoices?.bill_no ?? "—"}</td>
                  <td>{line.supplier_invoices?.invoice_no ?? "—"}</td>
                  <td>
                    {line.supplier_invoices?.invoice_date
                      ? formatDate(line.supplier_invoices.invoice_date)
                      : "—"}
                  </td>
                  {/* What the supplier billed, before any tax was held back --
                      the figure on their own invoice. */}
                  <td style={{ textAlign: "right" }}>
                    {money(
                      Number(line.supplier_invoices?.amount ?? 0) +
                        Number(line.supplier_invoices?.vat_amount ?? 0),
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{money(line.amount)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} style={{ textAlign: "center" }}>
                  No invoices matched to this cheque yet.
                </td>
              </tr>
            )}
            <tr>
              <td colSpan={3} style={{ fontWeight: 700 }}>
                Total
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>
                {money(grossSettled)}
              </td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>
                {money(applied)}
              </td>
            </tr>
          </tbody>
        </table>

        <table>
          <tbody>
            {/* Where the tax was held back on the bill rather than on this
                cheque, the voucher still has to explain why it pays less
                than the supplier invoiced. */}
            {withheldOnBills > 0 ? (
              <>
                <tr>
                  <th style={{ width: "22%" }}>Document total</th>
                  <td>{money(grossSettled)}</td>
                </tr>
                <tr>
                  <th>Less tax withheld</th>
                  <td>
                    ({money(withheldOnBills)}) — creditable, covered by BIR
                    Form 2307
                  </td>
                </tr>
              </>
            ) : null}
            <tr>
              <th style={{ width: "22%" }}>Amount</th>
              <td style={{ fontWeight: 700 }}>{money(amount)}</td>
            </tr>
            {withheld > 0 ? (
              <>
                <tr>
                  <th>Less tax withheld</th>
                  <td>
                    ({money(withheld)}) — creditable, covered by BIR Form 2307
                  </td>
                </tr>
                <tr>
                  <th>Net paid</th>
                  <td style={{ fontWeight: 700 }}>{money(amount - withheld)}</td>
                </tr>
              </>
            ) : null}
            <tr>
              <th>In words</th>
              <td>{inWords(amount - withheld)}</td>
            </tr>
            {applied !== amount ? (
              <tr>
                <th>Unmatched</th>
                <td>
                  {money(amount - applied)} of this cheque is not yet matched to
                  an invoice.
                </td>
              </tr>
            ) : null}
            {voucher.notes ? (
              <tr>
                <th>Notes</th>
                <td>{voucher.notes}</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div style={{ marginTop: "2.5rem", display: "flex", gap: "2rem" }}>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Prepared by
            </p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Approved by
            </p>
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
              Received by (Supplier)
            </p>
          </div>
        </div>

        <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", textAlign: "center" }}>
          {voucher.released_at
            ? `Released ${formatDate(voucher.released_at.slice(0, 10))} and posted to the general ledger.`
            : "Not yet released. This voucher has not been posted."}
        </p>
      </div>
    </>
  );
}
