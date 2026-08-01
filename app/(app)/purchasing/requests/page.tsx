import type { Metadata } from "next";
import Link from "next/link";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPurchaseRequest, submitPurchaseRequest } from "../actions";
import { PurchaseRequestForm, SubmitRequestForm } from "../purchasing-forms";

export const metadata: Metadata = { title: "Purchase requests" };

type RequestRow = {
  id: string;
  request_no: string;
  status: string;
  needed_by: string | null;
  justification: string | null;
  created_at: string;
  locations: { code: string; name: string } | null;
  purchase_request_lines: {
    description: string;
    quantity: string;
    estimated_price: string;
  }[];
};

const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  pending: "badge badge-brand",
  approved: "badge",
  rejected: "badge",
  ordered: "badge",
};

export default async function PurchaseRequestsPage() {
  const context = await requirePermission(MODULE.purchasingRequests, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingRequests, "edit");

  const supabase = await createClient();
  const [
    { data: requests },
    { data: items },
    { data: expenseAccounts },
    { data: locations },
  ] = await Promise.all([
    supabase
      .from("purchase_requests")
      .select(
        "id, request_no, status, needed_by, justification, created_at, locations(code, name), purchase_request_lines(description, quantity, estimated_price)",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<RequestRow[]>(),
    supabase
      .from("inventory_items")
      .select("id, name, unit_of_measure")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    // Non-stock lines — services, utilities — are charged to one of these.
    supabase
      .from("chart_of_accounts")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("account_type", "expense")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("locations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code"),
  ]);

  const rows = requests ?? [];
  const pending = rows.filter((row) => row.status === "pending");
  const approved = rows.filter((row) => row.status === "approved");

  return (
    <>
      <PageHeader
        title="Purchase requests"
        description="Nothing gets bought without a request and an approval — this is the paper trail."
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/purchasing/orders" className="btn btn-secondary btn-sm">
              Purchase orders
            </Link>
            <Link href="/purchasing/vendors" className="btn btn-secondary btn-sm">
              Suppliers
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile label="Awaiting approval" value={pending.length} hint="In the queue" />
        <StatTile label="Approved" value={approved.length} hint="Ready to order" />
        <StatTile
          label="Estimated value"
          value={money(
            rows
              .filter((row) => row.status === "pending" || row.status === "approved")
              .reduce(
                (sum, row) =>
                  sum +
                  (row.purchase_request_lines ?? []).reduce(
                    (lineSum, line) =>
                      lineSum + Number(line.quantity) * Number(line.estimated_price),
                    0,
                  ),
                0,
              ),
          )}
          hint="Pending and approved"
          tone="money"
        />
      </div>

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Raise a request"
            description="Saves as a draft. Submitting sends it to the approval queue."
          >
            <PurchaseRequestForm
              action={createPurchaseRequest}
              items={items ?? []}
              expenseAccounts={expenseAccounts ?? []}
              locations={locations ?? []}
            />
          </Card>
        </div>
      ) : null}

      <Card title="Requests" bodyClassName="">
        {rows.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Lines</th>
                  <th>Property</th>
                  <th>Needed by</th>
                  <th className="text-right">Estimate</th>
                  <th>Status</th>
                  {canEdit ? <th className="text-right">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((request) => {
                  const estimate = (request.purchase_request_lines ?? []).reduce(
                    (sum, line) =>
                      sum + Number(line.quantity) * Number(line.estimated_price),
                    0,
                  );
                  return (
                    <tr key={request.id}>
                      <td>
                        <span className="font-semibold text-sm">
                          {request.request_no}
                        </span>
                        {request.justification ? (
                          <p className="text-xs muted">{request.justification}</p>
                        ) : null}
                      </td>
                      <td className="text-xs">
                        {(request.purchase_request_lines ?? [])
                          .map((line) => `${Number(line.quantity)}× ${line.description}`)
                          .join(", ") || "—"}
                      </td>
                      <td className="text-xs">
                        {request.locations ? (
                          <>
                            <span className="badge">{request.locations.code}</span>
                            <p className="muted mt-0.5">{request.locations.name}</p>
                          </>
                        ) : (
                          <span className="muted">Company-wide</span>
                        )}
                      </td>
                      <td className="text-xs">{formatDate(request.needed_by)}</td>
                      <td className="text-right tabular-nums">{money(estimate)}</td>
                      <td>
                        <span className={STATUS_BADGE[request.status] ?? "badge"}>
                          {request.status}
                        </span>
                      </td>
                      {canEdit ? (
                        <td className="text-right">
                          {request.status === "draft" ? (
                            <SubmitRequestForm
                              action={submitPurchaseRequest}
                              requestId={request.id}
                            />
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No purchase requests yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
