import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { depositCheques } from "../../actions";
import { DepositSlipButton } from "../pdc-status-forms";
import { DepositSlipActions } from "./deposit-forms";

export const metadata: Metadata = { title: "Deposit slip" };

type ChequeRow = {
  id: string;
  pdc_no: string;
  check_no: string;
  bank: string;
  amount: string;
  maturity_date: string;
  status: string;
  tenants: { company_name: string } | null;
};

/**
 * The cashier's deposit run: every cheque that has reached its date and is
 * still in the drawer, grouped the way it is banked -- one slip per bank.
 */
export default async function DepositSlipPage() {
  const context = await requirePermission(MODULE.paymentsPdc, "view");
  const companyId = context.activeCompany!.companyId;
  const canDeposit = can(context.permissions, MODULE.paymentsPdc, "edit");

  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();

  const [{ data: cheques }, { data: company }] = await Promise.all([
    supabase
      .from("postdated_checks")
      .select(
        "id, pdc_no, check_no, bank, amount, maturity_date, status, tenants(company_name)",
      )
      .eq("company_id", companyId)
      .in("status", ["pending", "matured"])
      .lte("maturity_date", today)
      .order("bank")
      .order("maturity_date")
      .returns<ChequeRow[]>(),
    supabase
      .from("companies")
      .select("name, legal_name, address")
      .eq("id", companyId)
      .single(),
  ]);

  const rows = cheques ?? [];

  // One slip per bank -- a deposit slip cannot mix drawee banks.
  const byBank = new Map<string, ChequeRow[]>();
  for (const cheque of rows) {
    const list = byBank.get(cheque.bank) ?? [];
    list.push(cheque);
    byBank.set(cheque.bank, list);
  }

  const grandTotal = rows.reduce((sum, cheque) => sum + Number(cheque.amount), 0);

  return (
    <>
      <div className="no-print flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Deposit slip</h1>
          <p className="text-sm muted mt-0.5">
            Cheques that have reached their date and are still undeposited.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/payments/pdc" className="btn btn-secondary btn-sm">
            Back to cheques
          </Link>
          {rows.length > 0 ? <DepositSlipActions /> : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          No cheques are due for deposit. Anything still dated ahead stays in the
          register until it matures.
        </EmptyState>
      ) : (
        <div className="doc-sheet">
          <h1>Deposit slip</h1>
          <p style={{ textAlign: "center", marginBottom: "1.5rem" }}>
            {company?.legal_name ?? company?.name}
            {company?.address ? ` · ${company.address}` : ""}
            <br />
            Prepared {formatDate(today)}
          </p>

          {[...byBank.entries()].map(([bank, bankCheques], index) => {
            const subtotal = bankCheques.reduce(
              (sum, cheque) => sum + Number(cheque.amount),
              0,
            );
            return (
              <section
                key={bank}
                className={index > 0 ? "doc-page-break" : undefined}
              >
                <h2>
                  {bank} — {bankCheques.length} cheque
                  {bankCheques.length === 1 ? "" : "s"}
                </h2>
                <table>
                  <thead>
                    <tr>
                      <th>Ref.</th>
                      <th>Cheque no.</th>
                      <th>Drawer</th>
                      <th>Date</th>
                      <th style={{ textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankCheques.map((cheque) => (
                      <tr key={cheque.id}>
                        <td>{cheque.pdc_no}</td>
                        <td>{cheque.check_no}</td>
                        <td>{cheque.tenants?.company_name ?? "—"}</td>
                        <td>{formatDate(cheque.maturity_date)}</td>
                        <td style={{ textAlign: "right" }}>
                          {money(cheque.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={4} style={{ fontWeight: 700 }}>
                        Total for {bank}
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>
                        {money(subtotal)}
                      </td>
                    </tr>
                  </tbody>
                </table>

                {canDeposit ? (
                  <DepositSlipButton
                    action={depositCheques}
                    chequeIds={bankCheques.map((cheque) => cheque.id)}
                    label={`Mark this ${bank} slip deposited (${bankCheques.length})`}
                  />
                ) : null}
              </section>
            );
          })}

          {byBank.size > 1 ? (
            <>
              <h2>All banks</h2>
              <table>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 700 }}>
                      {rows.length} cheques across {byBank.size} banks
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700 }}>
                      {money(grandTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : null}

          <div style={{ marginTop: "2.5rem", display: "flex", gap: "3rem" }}>
            <div style={{ flex: 1 }}>
              <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
                Prepared by (Cashier)
              </p>
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ borderTop: "1px solid #9ca3af", paddingTop: "0.3rem" }}>
                Received by (Bank)
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
