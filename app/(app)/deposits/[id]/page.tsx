import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  addSettlementLine,
  approveSettlement,
  cancelSettlement,
  removeSettlementLine,
} from "../actions";
import { AddLineForm, ApproveSettlementForm } from "../settlement-forms";

export const metadata: Metadata = { title: "Deposit settlement" };

type Settlement = {
  id: string;
  company_id: string;
  contract_id: string;
  status: string;
  settled_on: string;
  deposit_held: string;
  notes: string | null;
  approved_at: string | null;
};

type Line = {
  id: string;
  kind: string;
  description: string;
  amount: string;
  invoice_id: string | null;
};

/**
 * One deposit, settled: what is held, what is being kept and why, and what is
 * therefore owed back.
 *
 * The refundable figure is worked out here rather than typed, and approving is
 * what turns it into money the cashier may pay. Before approval this page moves
 * nothing at all.
 */
export default async function SettlementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.contractDeposits, "view");
  const companyId = context.activeCompany!.companyId;
  const canPrepare = can(context.permissions, MODULE.contractDeposits, "edit");
  const canApprove = can(context.permissions, MODULE.contractDeposits, "approve");

  const supabase = await createClient();

  const { data: settlement } = await supabase
    .from("deposit_settlements")
    .select(
      "id, company_id, contract_id, status, settled_on, deposit_held, notes, approved_at",
    )
    .eq("id", id)
    .maybeSingle<Settlement>();

  if (!settlement || settlement.company_id !== companyId) notFound();

  const [{ data: lines }, { data: fund }, { data: contract }, { data: openBills }] =
    await Promise.all([
      supabase
        .from("deposit_settlement_lines")
        .select("id, kind, description, amount, invoice_id")
        .eq("settlement_id", id)
        .order("created_at")
        .returns<Line[]>(),
      supabase
        .from("contract_fund_status")
        .select("deposit_taken, deposit_received, deposit_remaining")
        .eq("contract_id", settlement.contract_id)
        .maybeSingle<{
          deposit_taken: string;
          deposit_received: string;
          deposit_remaining: string;
        }>(),
      supabase
        .from("contracts")
        .select("contract_no, end_date, tenants(company_name)")
        .eq("id", settlement.contract_id)
        .maybeSingle<{
          contract_no: string;
          end_date: string;
          tenants: { company_name: string } | null;
        }>(),
      supabase
        .from("invoices")
        .select("id, invoice_no, total, amount_paid, credited_amount")
        .eq("contract_id", settlement.contract_id)
        .in("status", ["released", "partially_paid"])
        .returns<
          {
            id: string;
            invoice_no: string;
            total: string;
            amount_paid: string;
            credited_amount: string;
          }[]
        >(),
    ]);

  const rows = lines ?? [];
  const isDraft = settlement.status === "draft";

  /*
   * A draft measures against what is held now; an approved one against the
   * figure stamped when it was approved, so the document keeps reading
   * correctly however the contract moves afterwards.
   */
  const held = isDraft
    ? Number(fund?.deposit_remaining ?? 0)
    : Number(settlement.deposit_held);

  const deductions = rows
    .filter((row) => row.kind === "deduction")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const forfeited = rows
    .filter((row) => row.kind === "forfeiture")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const refundable = held - deductions - forfeited;

  const bills = (openBills ?? []).map((row) => ({
    id: row.id,
    label: `${row.invoice_no} — ${money(
      Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount),
    )} outstanding`,
    balance:
      Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount),
  }));
  const billNo = new Map((openBills ?? []).map((row) => [row.id, row.invoice_no]));

  return (
    <>
      <PageHeader
        title={`Deposit settlement — ${contract?.contract_no ?? ""}`}
        description={`${contract?.tenants?.company_name ?? "Unknown tenant"} · ${formatDate(settlement.settled_on)}${
          settlement.approved_at
            ? ` · approved ${formatDate(settlement.approved_at)}`
            : ""
        }`}
        action={
          <div className="flex gap-2">
            <Link href="/deposits" className="btn btn-secondary btn-sm">
              Back
            </Link>
            {isDraft && canPrepare ? (
              <form action={cancelSettlement}>
                <input type="hidden" name="id" value={settlement.id} />
                <button type="submit" className="btn btn-secondary btn-sm">
                  Cancel settlement
                </button>
              </form>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        {[
          ["Deposit held", money(held), "Received, less anything already drawn"],
          ["Deductions", money(deductions), "Repairs, damage and bills"],
          ["Forfeited", money(forfeited), "Kept under the contract"],
        ].map(([label, value, hint]) => (
          <div className="card" key={label}>
            <div className="card-body">
              <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
                {label}
              </p>
              <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
              <p className="text-xs muted mt-1">{hint}</p>
            </div>
          </div>
        ))}
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Refundable
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{
                color:
                  refundable < 0 ? "var(--danger)" : "var(--color-gold-500)",
              }}
            >
              {money(refundable)}
            </p>
            <p className="text-xs muted mt-1">
              {refundable < 0
                ? "More is being kept than is held"
                : settlement.status === "approved"
                  ? "Payable to the tenant"
                  : "Once approved"}
            </p>
          </div>
        </div>
      </div>

      {settlement.status === "approved" ? (
        <div className="mb-6">
          <Card title="Approved">
            <p className="text-sm">
              This settlement has been approved, so its lines can no longer be
              changed. The deductions have been posted and{" "}
              <strong>{money(refundable)}</strong> may now be refunded from{" "}
              <Link
                href="/payments"
                style={{ color: "var(--color-brand-600)" }}
              >
                Payments
              </Link>{" "}
              as a “Refund — deposit returned”.
            </p>
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="What is being kept" bodyClassName="">
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>For what</th>
                    <th>Kind</th>
                    <th>Settles</th>
                    <th className="text-right">Amount</th>
                    {isDraft && canPrepare ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="text-sm">{row.description}</td>
                      <td>
                        <span className="badge">
                          {row.kind === "forfeiture" ? "forfeiture" : "deduction"}
                        </span>
                      </td>
                      <td className="text-xs muted">
                        {row.invoice_id
                          ? (billNo.get(row.invoice_id) ?? "a bill")
                          : row.kind === "forfeiture"
                            ? "Contract terms"
                            : "Repair or damage"}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.amount)}
                      </td>
                      {isDraft && canPrepare ? (
                        <td className="text-right">
                          <form action={removeSettlementLine}>
                            <input type="hidden" name="id" value={row.id} />
                            <input
                              type="hidden"
                              name="settlement_id"
                              value={settlement.id}
                            />
                            <button
                              type="submit"
                              className="btn btn-secondary btn-sm"
                            >
                              Remove
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              Nothing is being kept — the whole deposit is refundable.
            </EmptyState>
          )}
        </Card>
      </div>

      {isDraft && canPrepare ? (
        <div className="mb-6">
          <Card
            title="Add a deduction or forfeiture"
            description="Each line says what is kept and why. A line naming a bill settles that bill; one without is a repair or damage charge."
          >
            <AddLineForm
              action={addSettlementLine}
              settlementId={settlement.id}
              invoices={bills}
            />
          </Card>
        </div>
      ) : null}

      {isDraft ? (
        <Card
          title="Approval"
          description="Approving posts the deductions to the ledger and releases the refund. It cannot be undone from here."
        >
          {canApprove ? (
            refundable < 0 ? (
              <p className="text-sm" style={{ color: "var(--danger)" }}>
                This settlement keeps {money(deductions + forfeited)} but only{" "}
                {money(held)} is held. Remove a line before approving.
              </p>
            ) : (
              <ApproveSettlementForm
                action={approveSettlement}
                settlementId={settlement.id}
                refundable={refundable}
              />
            )
          ) : (
            <p className="text-sm muted">
              Waiting on somebody with the approve right on Deposit Settlement.
              You can prepare it, but not approve your own.
            </p>
          )}
        </Card>
      ) : null}
    </>
  );
}
