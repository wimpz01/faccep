import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { requirePermission } from "@/lib/auth";
import { formatDate, formatDateLong, money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Cheque receipt" };

/**
 * The paper the tenant keeps.
 *
 * Handing over a year of postdated cheques is the tenant parting with a year
 * of rent on trust, so they should walk away with a list of exactly what they
 * gave and a signature saying it was taken. That is all this is: an
 * acknowledgement of receipt, not a receipt for payment. Nothing here has been
 * banked and nothing has settled a bill, and the wording says so, because a
 * document that looks like an official receipt would be the wrong document.
 */
export default async function ChequeReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.contracts, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();

  const { data: contract } = await supabase
    .from("contracts")
    .select(
      "id, company_id, contract_no, start_date, end_date, tenants(company_name, address, contact_person)",
    )
    .eq("id", id)
    .maybeSingle<{
      id: string;
      company_id: string;
      contract_no: string;
      start_date: string;
      end_date: string;
      tenants: {
        company_name: string;
        address: string | null;
        contact_person: string | null;
      } | null;
    }>();

  if (!contract || contract.company_id !== companyId) notFound();

  const [{ data: chequeRows }, { data: company }] = await Promise.all([
    supabase
      .from("contract_cheque_receipts")
      .select("id, bank, cheque_no, amount, cheque_date")
      .eq("contract_id", id)
      .order("cheque_date")
      .returns<
        {
          id: string;
          bank: string;
          cheque_no: string;
          amount: string;
          cheque_date: string;
        }[]
      >(),
    supabase
      .from("companies")
      .select("name, legal_name, address, tin, contact_number")
      .eq("id", companyId)
      .maybeSingle<{
        name: string;
        legal_name: string | null;
        address: string | null;
        tin: string | null;
        contact_number: string | null;
      }>(),
  ]);

  const cheques = chequeRows ?? [];
  const total = cheques.reduce((sum, row) => sum + Number(row.amount), 0);

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
        <Link href={`/contracts/${contract.id}`} className="btn btn-secondary btn-sm">
          Back to contract
        </Link>
        <PrintButton />
        <p className="text-xs muted">
          An acknowledgement of cheques received — not a receipt for payment.
        </p>
      </div>

      <article className="doc-sheet card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
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
            <h1 style={{ margin: 0 }}>ACKNOWLEDGEMENT OF CHEQUES RECEIVED</h1>
            <p style={{ fontSize: "0.78rem", marginTop: 4 }}>
              Contract {contract.contract_no}
            </p>
            <p style={{ fontSize: "0.78rem" }}>
              {formatDate(contract.start_date)} to {formatDate(contract.end_date)}
            </p>
          </div>
        </div>

        <hr style={{ margin: "0.9rem 0", borderColor: "#000" }} />

        <div style={{ fontSize: "0.82rem" }}>
          <p style={caption}>Received from</p>
          <p style={{ fontWeight: 700 }}>
            {contract.tenants?.company_name ?? "—"}
          </p>
          {contract.tenants?.contact_person ? (
            <p>attn. {contract.tenants.contact_person}</p>
          ) : null}
          {contract.tenants?.address ? <p>{contract.tenants.address}</p> : null}
        </div>

        <p style={{ fontSize: "0.82rem", marginTop: "0.9rem" }}>
          The following {cheques.length} postdated cheque
          {cheques.length === 1 ? " was" : "s were"} received in connection with
          contract {contract.contract_no}:
        </p>

        <table className="table" style={{ marginTop: "0.6rem" }}>
          <thead>
            <tr>
              <th style={{ width: "2.5rem" }}>#</th>
              <th>Bank</th>
              <th>Cheque number</th>
              <th>Cheque date</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {cheques.map((cheque, index) => (
              <tr key={cheque.id}>
                <td className="tabular-nums">{index + 1}</td>
                <td>{cheque.bank}</td>
                <td className="tabular-nums">{cheque.cheque_no}</td>
                <td>{formatDate(cheque.cheque_date)}</td>
                <td style={{ textAlign: "right" }} className="tabular-nums">
                  {money(cheque.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4} style={{ textAlign: "right" }}>
                Total
              </th>
              <th style={{ textAlign: "right" }} className="tabular-nums">
                {money(total)}
              </th>
            </tr>
          </tfoot>
        </table>

        <p style={{ fontSize: "0.72rem", color: "#444", marginTop: "0.9rem" }}>
          These cheques are held as security for the rent falling due under the
          contract above. This acknowledges receipt of the instruments only; it
          is not a receipt for payment, and no cheque listed here has been
          presented or credited. An official receipt is issued for each cheque
          as and when it clears.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1.4rem",
            marginTop: "2.2rem",
            fontSize: "0.78rem",
          }}
        >
          <div>
            <div style={rule} />
            <p style={caption}>Received by — signature over printed name</p>
          </div>
          <div>
            <div style={rule} />
            <p style={caption}>Tenant — signature over printed name</p>
          </div>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#444", marginTop: "1.2rem" }}>
          Issued {formatDateLong(new Date().toISOString().slice(0, 10))}.
        </p>
      </article>
    </>
  );
}
