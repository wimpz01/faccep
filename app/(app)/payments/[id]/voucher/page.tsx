import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { requirePermission } from "@/lib/auth";
import { formatDate, formatDateLong, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Disbursement voucher" };

type VoucherPayment = {
  id: string;
  company_id: string;
  payment_no: string;
  payment_kind: string;
  fund_kind: string | null;
  payment_mode: string;
  payment_date: string;
  amount: string;
  reference: string | null;
  check_bank: string | null;
  check_date: string | null;
  status: string;
  notes: string | null;
  tenants: { company_name: string; address: string | null; tin: string | null } | null;
  contracts: { contract_no: string } | null;
};

/**
 * The paper that goes with money leaving the company.
 *
 * A receipt evidences money coming in and is the tenant's proof of payment. A
 * disbursement is the other way round, so the proof has to run the other way
 * too: the company needs the payee's signature saying they received it. That
 * acknowledgement is the whole point of the document, which is why it is the
 * one part of this page that is deliberately blank.
 *
 * Only refunds are vouchered. A collection has its own receipt and would say
 * the opposite of the truth on this form.
 */
export default async function VoucherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payments, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const { data: payment } = await supabase
    .from("payments")
    .select(
      `id, company_id, payment_no, payment_kind, fund_kind, payment_mode,
       payment_date, amount, reference, check_bank, check_date, status, notes,
       tenants(company_name, address, tin),
       contracts(contract_no)`,
    )
    .eq("id", id)
    .maybeSingle<VoucherPayment>();

  if (!payment || payment.company_id !== companyId) notFound();
  // A collection is receipted, not vouchered.
  if (payment.payment_kind !== "refund") notFound();

  const { data: company } = await supabase
    .from("companies")
    .select("name, legal_name, address, tin, contact_number")
    .eq("id", companyId)
    .maybeSingle<{
      name: string;
      legal_name: string | null;
      address: string | null;
      tin: string | null;
      contact_number: string | null;
    }>();

  const fund =
    payment.fund_kind === "advance_payment"
      ? "Advance / prepayment"
      : "Security deposit";
  const isCheque = payment.payment_mode === "check";

  const rule: React.CSSProperties = {
    borderBottom: "1px solid #000",
    minHeight: "1.6rem",
  };
  const caption: React.CSSProperties = {
    fontSize: "0.68rem",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#444",
    marginTop: 2,
  };

  return (
    <>
      <div className="no-print mb-4 flex gap-2 flex-wrap items-center">
        <Link href={`/payments/${payment.id}`} className="btn btn-secondary btn-sm">
          Back to payment
        </Link>
        <PrintButton />
        <p className="text-xs muted">
          A printed rendering of the posted disbursement — not an editable
          document.
        </p>
      </div>

      {payment.status === "voided" ? (
        <div className="no-print card mb-4">
          <div className="card-body">
            <p className="text-sm">
              This disbursement has been <strong>voided</strong>. It is kept for
              the record and its effect reversed.
            </p>
          </div>
        </div>
      ) : null}

      <article className="doc-sheet card">
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}
        >
          <div>
            <p style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 2 }}>
              {company?.legal_name ?? company?.name}
            </p>
            {company?.address ? (
              <p style={{ fontSize: "0.78rem" }}>{company.address}</p>
            ) : null}
            <p style={{ fontSize: "0.78rem" }}>
              {company?.tin ? `TIN ${company.tin}` : null}
              {company?.contact_number ? ` · ${company.contact_number}` : null}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <h1 style={{ margin: 0 }}>DISBURSEMENT VOUCHER</h1>
            <p style={{ fontWeight: 700, fontSize: "1rem", marginTop: 4 }}>
              {payment.payment_no}
            </p>
            <p style={{ fontSize: "0.78rem" }}>
              {formatDate(payment.payment_date)}
            </p>
          </div>
        </div>

        <hr style={{ margin: "0.9rem 0", borderColor: "#000" }} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.9rem",
            fontSize: "0.82rem",
          }}
        >
          <div>
            <p style={caption}>Paid to</p>
            <p style={{ fontWeight: 700 }}>
              {payment.tenants?.company_name ?? "—"}
            </p>
            {payment.tenants?.address ? <p>{payment.tenants.address}</p> : null}
            {payment.tenants?.tin ? <p>TIN {payment.tenants.tin}</p> : null}
          </div>
          <div>
            <p style={caption}>Particulars</p>
            <p>
              Refund of {fund.toLowerCase()}
              {payment.contracts?.contract_no
                ? ` under contract ${payment.contracts.contract_no}`
                : ""}
              .
            </p>
            {payment.notes ? <p style={{ marginTop: 4 }}>{payment.notes}</p> : null}
          </div>
        </div>

        <table className="table" style={{ marginTop: "1rem" }}>
          <thead>
            <tr>
              <th>Particulars</th>
              <th style={{ textAlign: "right", width: "10rem" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Refund of {fund.toLowerCase()}
                {payment.contracts?.contract_no
                  ? ` — contract ${payment.contracts.contract_no}`
                  : ""}
              </td>
              <td style={{ textAlign: "right" }} className="tabular-nums">
                {money(payment.amount)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th style={{ textAlign: "right" }}>Total</th>
              <th style={{ textAlign: "right" }} className="tabular-nums">
                {money(payment.amount)}
              </th>
            </tr>
          </tfoot>
        </table>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "0.9rem",
            fontSize: "0.82rem",
            marginTop: "0.9rem",
          }}
        >
          <div>
            <p style={caption}>Paid by</p>
            <p style={{ fontWeight: 700 }}>
              {isCheque ? "Cheque" : payment.payment_mode.replace("_", " ")}
            </p>
          </div>
          <div>
            <p style={caption}>Cheque number</p>
            <p style={{ fontWeight: 700 }}>{payment.reference ?? "—"}</p>
          </div>
          <div>
            <p style={caption}>Bank / cheque date</p>
            <p style={{ fontWeight: 700 }}>
              {payment.check_bank ?? "—"}
              {payment.check_date ? ` · ${formatDate(payment.check_date)}` : ""}
            </p>
          </div>
        </div>

        {/*
          The signatures. Left deliberately blank: this is the part that is
          filled in on paper, and the payee's is what proves the money was
          actually handed over.
        */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "1.4rem",
            marginTop: "2.2rem",
            fontSize: "0.78rem",
          }}
        >
          <div>
            <div style={rule} />
            <p style={caption}>Prepared by</p>
          </div>
          <div>
            <div style={rule} />
            <p style={caption}>Approved by</p>
          </div>
          <div>
            <div style={rule} />
            <p style={caption}>Received the above amount</p>
          </div>
        </div>

        <div style={{ marginTop: "1.4rem", fontSize: "0.78rem" }}>
          <div style={{ display: "flex", gap: "1.4rem" }}>
            <div style={{ flex: 1 }}>
              <div style={rule} />
              <p style={caption}>Payee — signature over printed name</p>
            </div>
            <div style={{ width: "12rem" }}>
              <div style={rule} />
              <p style={caption}>Date received</p>
            </div>
          </div>
          <p style={{ marginTop: "1rem", fontSize: "0.72rem", color: "#444" }}>
            Received from {company?.legal_name ?? company?.name} the sum of{" "}
            <strong>{money(payment.amount)}</strong> on{" "}
            {formatDateLong(payment.payment_date)}, in full settlement of the{" "}
            {fund.toLowerCase()} stated above.
          </p>
        </div>
      </article>
    </>
  );
}
