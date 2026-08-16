import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { openSettlement } from "./actions";
import { OpenSettlementForm } from "./settlement-forms";

export const metadata: Metadata = { title: "Deposit settlement" };

type SettlementRow = {
  id: string;
  contract_id: string;
  status: string;
  settled_on: string;
  deposit_held: string;
  approved_at: string | null;
};

/**
 * Every deposit being settled, and the ones still waiting to be.
 *
 * The list is the queue: billing opens a settlement, a manager approves it,
 * and only then can the cashier pay the balance back. Showing what is held but
 * unsettled alongside it is what stops a tenancy ending with the deposit
 * quietly still on the books.
 */
export default async function DepositsPage() {
  const context = await requirePermission(MODULE.contractDeposits, "view");
  const companyId = context.activeCompany!.companyId;
  const canPrepare = can(context.permissions, MODULE.contractDeposits, "edit");

  const supabase = await createClient();

  const [{ data: settlements }, { data: funds }, { data: contracts }] =
    await Promise.all([
      supabase
        .from("deposit_settlements")
        .select("id, contract_id, status, settled_on, deposit_held, approved_at")
        .eq("company_id", companyId)
        .neq("status", "cancelled")
        .order("settled_on", { ascending: false })
        .returns<SettlementRow[]>(),
      supabase
        .from("contract_fund_status")
        .select("contract_id, deposit_remaining")
        .eq("company_id", companyId)
        .returns<{ contract_id: string; deposit_remaining: string }[]>(),
      // Read the table and merge the view by id: PostgREST cannot follow a
      // relation out of a view.
      supabase
        .from("contracts")
        .select("id, contract_no, status, tenants(company_name)")
        .eq("company_id", companyId)
        .returns<
          {
            id: string;
            contract_no: string;
            status: string;
            tenants: { company_name: string } | null;
          }[]
        >(),
    ]);

  const heldBy = new Map(
    (funds ?? []).map((row) => [row.contract_id, Number(row.deposit_remaining)]),
  );
  const contractBy = new Map((contracts ?? []).map((row) => [row.id, row]));
  const settledContracts = new Set(
    (settlements ?? []).map((row) => row.contract_id),
  );

  const label = (contractId: string) => {
    const contract = contractBy.get(contractId);
    return contract
      ? `${contract.tenants?.company_name ?? "Unknown tenant"} — ${contract.contract_no}`
      : "Unknown contract";
  };

  // Only what still holds money and has no settlement open already.
  const settleable = (contracts ?? [])
    .filter(
      (row) =>
        (heldBy.get(row.id) ?? 0) > 0 &&
        !settledContracts.has(row.id) &&
        row.status !== "draft",
    )
    .map((row) => ({
      id: row.id,
      label: `${row.tenants?.company_name ?? "Unknown tenant"} — ${row.contract_no}`,
      held: heldBy.get(row.id) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const rows = settlements ?? [];
  const awaiting = rows.filter((row) => row.status === "draft");
  const unsettledValue = settleable.reduce((sum, row) => sum + row.held, 0);

  return (
    <>
      <PageHeader
        title="Deposit settlement"
        description="What is kept out of a security deposit, and what is left to give back. Nothing moves until a settlement is approved."
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Awaiting approval"
          value={awaiting.length}
          hint="Prepared, not yet approved"
        />
        <StatTile
          label="Approved"
          value={rows.length - awaiting.length}
          hint="Refund can be paid"
        />
        <StatTile
          label="Held, not yet settled"
          value={money(unsettledValue)}
          hint={`${settleable.length} contract${settleable.length === 1 ? "" : "s"}`}
          tone="money"
        />
      </div>

      {canPrepare ? (
        <div className="mb-6">
          <Card
            title="Settle a deposit"
            description="Open the reckoning for one contract, then list what is being kept."
          >
            <OpenSettlementForm action={openSettlement} contracts={settleable} />
          </Card>
        </div>
      ) : null}

      <Card title="Settlements" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Date</th>
                  <th className="text-right">Deposit held</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        href={`/deposits/${row.id}`}
                        className="font-semibold text-sm"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {label(row.contract_id)}
                      </Link>
                    </td>
                    <td className="text-xs">{formatDate(row.settled_on)}</td>
                    <td className="text-right tabular-nums">
                      {row.status === "approved"
                        ? money(row.deposit_held)
                        : money(heldBy.get(row.contract_id) ?? 0)}
                    </td>
                    <td>
                      <span
                        className={
                          row.status === "approved" ? "badge badge-brand" : "badge"
                        }
                      >
                        {row.status === "approved" ? "approved" : "awaiting approval"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            No deposit has been settled yet
            {canPrepare && settleable.length > 0
              ? " — open one above."
              : "."}
          </EmptyState>
        )}
      </Card>
    </>
  );
}
