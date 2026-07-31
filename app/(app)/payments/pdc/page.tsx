import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { recordPdc, setPdcStatus } from "../actions";
import { PdcForm } from "../payment-forms";

export const metadata: Metadata = { title: "Postdated cheques" };

type PdcRow = {
  id: string;
  check_no: string;
  bank: string;
  amount: string;
  maturity_date: string;
  status: string;
  deposited_at: string | null;
  notes: string | null;
  tenants: { company_name: string } | null;
};

const NEXT_STATUS: Record<string, { value: string; label: string }[]> = {
  pending: [
    { value: "matured", label: "Mark matured" },
    { value: "cancelled", label: "Cancel" },
  ],
  matured: [
    { value: "deposited", label: "Mark deposited" },
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

export default async function PdcPage() {
  const context = await requirePermission(MODULE.paymentsPdc, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.paymentsPdc, "edit");

  const supabase = await createClient();
  const [{ data: cheques }, { data: tenants }] = await Promise.all([
    supabase
      .from("postdated_checks")
      .select(
        "id, check_no, bank, amount, maturity_date, status, deposited_at, notes, tenants(company_name)",
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
    (row) => row.maturity_date <= in30 && row.maturity_date >= today,
  );
  const overdueForDeposit = onHand.filter((row) => row.maturity_date < today);

  return (
    <>
      <PageHeader
        title="Postdated cheques"
        description="Cheques held on file, their maturity dates and where each one has got to."
        action={
          <Link href="/payments" className="btn btn-secondary btn-sm">
            Back to payments
          </Link>
        }
      />

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
          value={overdueForDeposit.length}
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
                  const isDue =
                    (cheque.status === "pending" || cheque.status === "matured") &&
                    cheque.maturity_date <= today;
                  return (
                    <tr key={cheque.id}>
                      <td>
                        <span className="font-semibold text-sm">{cheque.check_no}</span>
                        <p className="text-xs muted">{cheque.bank}</p>
                      </td>
                      <td className="text-sm">{cheque.tenants?.company_name ?? "—"}</td>
                      <td className="text-xs">
                        {formatDate(cheque.maturity_date)}
                        {isDue ? (
                          <p style={{ color: "var(--danger)" }}>due for deposit</p>
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
                          <div className="inline-flex gap-1 flex-wrap justify-end">
                            {(NEXT_STATUS[cheque.status] ?? []).map((option) => (
                              <form action={setPdcStatus} key={option.value}>
                                <input type="hidden" name="id" value={cheque.id} />
                                <input
                                  type="hidden"
                                  name="status"
                                  value={option.value}
                                />
                                <button
                                  type="submit"
                                  className="btn btn-secondary btn-sm"
                                >
                                  {option.label}
                                </button>
                              </form>
                            ))}
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
