import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { recordPdc, setPdcStatus } from "../actions";
import { PdcForm } from "../payment-forms";
import { ChequeStatusActions } from "./pdc-status-forms";

export const metadata: Metadata = { title: "Postdated cheques" };

type PdcRow = {
  id: string;
  check_no: string;
  pdc_no: string;
  bank: string;
  amount: string;
  maturity_date: string;
  status: string;
  deposited_at: string | null;
  payment_id: string | null;
  notes: string | null;
  tenants: { company_name: string } | null;
};

/**
 * What a cheque may move to next.
 *
 * `hasMatured` gates the steps that cannot happen before the date on the
 * cheque: it is not matured until its date, and it cannot be banked before
 * then either. The database refuses both regardless, so this only keeps the
 * button from being offered.
 */
function nextStatuses(status: string, hasMatured: boolean) {
  const options: Record<string, { value: string; label: string }[]> = {
    pending: [
      ...(hasMatured ? [{ value: "matured", label: "Mark matured" }] : []),
      { value: "cancelled", label: "Cancel" },
    ],
    matured: [
      ...(hasMatured ? [{ value: "deposited", label: "Mark deposited" }] : []),
      { value: "bounced", label: "Mark bounced" },
    ],
    deposited: [
      { value: "cleared", label: "Mark cleared" },
      { value: "bounced", label: "Mark bounced" },
    ],
    bounced: [{ value: "pending", label: "Reinstate" }],
    cleared: [],
    cancelled: [{ value: "pending", label: "Reinstate" }],
  };
  return options[status] ?? [];
}

export default async function PdcPage() {
  const context = await requirePermission(MODULE.paymentsPdc, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.paymentsPdc, "edit");

  const supabase = await createClient();
  const [{ data: cheques }, { data: tenants }] = await Promise.all([
    supabase
      .from("postdated_checks")
      .select(
        "id, check_no, pdc_no, bank, amount, maturity_date, status, deposited_at, payment_id, notes, tenants(company_name)",
      )
      .eq("company_id", companyId)
      .order("maturity_date")
      .returns<PdcRow[]>(),
    supabase
      .from("tenants")
      .select("id, company_name")
      .eq("company_id", companyId)
      .order("company_name"),
  ]);

  const rows = cheques ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const onHand = rows.filter((row) => row.status === "pending" || row.status === "matured");
  const maturingSoon = onHand.filter(
    (row) => row.maturity_date <= in30 && row.maturity_date > today,
  );
  // A cheque dated today can be banked today, so maturity is inclusive.
  const readyToDeposit = onHand.filter((row) => row.maturity_date <= today);
  const readyValue = readyToDeposit.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );
  // Cleared by the bank but never turned into a collection, so the invoice it
  // was meant to settle is still showing as unpaid.
  const awaitingCollection = rows.filter(
    (row) => row.status === "cleared" && !row.payment_id,
  );
  const awaitingValue = awaitingCollection.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );

  return (
    <>
      <PageHeader
        title="Postdated cheques"
        description="Cheques held on file, their maturity dates and where each one has got to."
        action={
          <div className="flex gap-2">
            <Link href="/payments" className="btn btn-secondary btn-sm">
              Back to payments
            </Link>
            <Link
              href="/payments/pdc/deposit-slip"
              className="btn btn-primary btn-sm"
            >
              Deposit slip
            </Link>
          </div>
        }
      />

      {readyToDeposit.length > 0 ? (
        <div
          className="card mb-6"
          style={{ borderColor: "var(--danger)", borderWidth: "1.5px" }}
        >
          <div className="card-body flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm">
              <strong style={{ color: "var(--danger)" }}>
                {readyToDeposit.length} cheque
                {readyToDeposit.length === 1 ? "" : "s"} matured and still
                undeposited
              </strong>
              <span className="muted"> — {money(readyValue)} sitting in the drawer.</span>
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

      {awaitingCollection.length > 0 ? (
        <div
          className="card mb-6"
          style={{ borderColor: "var(--color-brand-500)", borderWidth: "1.5px" }}
        >
          <div className="card-body flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm">
              <strong style={{ color: "var(--color-brand-600)" }}>
                {awaitingCollection.length} cleared cheque
                {awaitingCollection.length === 1 ? "" : "s"} not yet collected
              </strong>
              <span className="muted">
                {" "}
                — {money(awaitingValue)} honoured by the bank but still showing
                unpaid on the invoices.
              </span>
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="On hand"
          value={money(onHand.reduce((sum, row) => sum + Number(row.amount), 0))}
          hint={`${onHand.length} cheque(s)`}
          tone="money"
        />
        <StatTile
          label="Maturing in 30 days"
          value={maturingSoon.length}
          hint="Prepare a deposit slip"
        />
        <StatTile
          label="Past maturity"
          value={readyToDeposit.length}
          hint="Not yet deposited"
        />
        <StatTile
          label="Bounced"
          value={rows.filter((row) => row.status === "bounced").length}
          hint="Needs follow-up"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card title="Record a cheque">
            <PdcForm action={recordPdc} tenants={tenants ?? []} />
          </Card>
        </div>
      ) : null}

      <Card title="Cheque register" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Cheque</th>
                  <th>Tenant</th>
                  <th>Maturity</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Move to</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((cheque) => {
                  const hasMatured = cheque.maturity_date <= today;
                  const isDue =
                    (cheque.status === "pending" || cheque.status === "matured") &&
                    hasMatured;
                  return (
                    <tr key={cheque.id}>
                      <td>
                        <span className="font-semibold text-sm tabular-nums">
                          {cheque.pdc_no}
                        </span>
                        <p className="text-xs muted">
                          Cheque {cheque.check_no} · {cheque.bank}
                        </p>
                      </td>
                      <td className="text-sm">{cheque.tenants?.company_name ?? "—"}</td>
                      <td className="text-xs">
                        {formatDate(cheque.maturity_date)}
                        {isDue ? (
                          <p style={{ color: "var(--danger)" }}>due for deposit</p>
                        ) : !hasMatured ? (
                          <p className="muted">not payable yet</p>
                        ) : null}
                      </td>
                      <td className="text-right tabular-nums">{money(cheque.amount)}</td>
                      <td>
                        <span className="badge">{cheque.status}</span>
                        {cheque.deposited_at ? (
                          <p className="text-xs muted">
                            {formatDate(cheque.deposited_at)}
                          </p>
                        ) : null}
                      </td>
                      {canEdit ? (
                        <td className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <div className="inline-flex gap-1 flex-wrap justify-end">
                              {cheque.status === "cleared" && !cheque.payment_id ? (
                                <Link
                                  href={`/payments/pdc/${cheque.id}/collect`}
                                  className="btn btn-primary btn-sm"
                                >
                                  Post collection
                                </Link>
                              ) : null}
                              {cheque.payment_id ? (
                                <Link
                                  href={`/payments/${cheque.payment_id}`}
                                  className="btn btn-secondary btn-sm"
                                >
                                  View payment
                                </Link>
                              ) : null}
                            </div>
                            <ChequeStatusActions
                              action={setPdcStatus}
                              chequeId={cheque.id}
                              options={nextStatuses(cheque.status, hasMatured)}
                            />
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No cheques on file.</EmptyState>
        )}
      </Card>
    </>
  );
}
