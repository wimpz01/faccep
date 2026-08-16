import type { Metadata } from "next";
import Link from "next/link";

import { Card, FilterNote, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { createPurchaseRequest, submitPurchaseRequest } from "../actions";
import { PurchaseRequestForm } from "../purchasing-forms";
import { RequestList } from "../request-list";

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

export default async function PurchaseRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; add?: string }>;
}) {
  const { view, add } = await searchParams;
  const context = await requirePermission(MODULE.purchasingRequests, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.purchasingRequests, "edit");

  const supabase = await createClient();
  const [
    { data: requests },
    { data: items },
    { data: expenseAccounts },
    { data: locations },
    { data: jobs },
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
      .select("id, name, sku, unit_of_measure, quantity_on_hand")
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
    /*
     * Jobs a request could still be buying for. A closed job is left out: the
     * work is done and paid for, and offering it invites the spend to be hung
     * on the wrong one. Existing links are unaffected -- this is only what the
     * picker offers.
     */
    supabase
      .from("maintenance_jobs")
      .select("id, job_no, job_kind, description, status, location_id")
      .eq("company_id", companyId)
      .not("status", "in", "(closed,cancelled)")
      .order("job_no", { ascending: false })
      .limit(200)
      .returns<
        {
          id: string;
          job_no: string;
          job_kind: string;
          description: string | null;
          status: string;
          location_id: string | null;
        }[]
      >(),
  ]);

  const rows = requests ?? [];
  const pending = rows.filter((row) => row.status === "pending");
  const approved = rows.filter((row) => row.status === "approved");

  // Clicking a figure narrows the list below it to exactly what it counted.
  const shown =
    view === "pending" ? pending : view === "approved" ? approved : rows;
  const adding = canEdit && add === "1";
  const filterLabel =
    view === "pending"
      ? "requests awaiting approval"
      : view === "approved"
        ? "approved requests, ready to order"
        : null;

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
            {canEdit ? (
              adding ? (
                <Link
                  href="/purchasing/requests"
                  className="btn btn-secondary btn-sm"
                >
                  Close
                </Link>
              ) : (
                <Link
                  href="/purchasing/requests?add=1"
                  className="btn btn-primary btn-sm"
                >
                  + Raise request
                </Link>
              )
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <StatTile
          label="Awaiting approval"
          value={pending.length}
          hint="In the queue"
          href="/purchasing/requests?view=pending"
        />
        <StatTile
          label="Approved"
          value={approved.length}
          hint="Ready to order"
          href="/purchasing/requests?view=approved"
        />
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

      {adding ? (
        <div className="mb-6">
          <Card
            title="Raise a request"
            description="Saves as a draft. Submitting sends it to the approval queue."
          >
            <PurchaseRequestForm
              action={createPurchaseRequest}
              items={(items ?? []).map((item) => ({
                ...item,
                onHand: Number(item.quantity_on_hand ?? 0),
              }))}
              expenseAccounts={expenseAccounts ?? []}
              locations={locations ?? []}
              jobs={(jobs ?? []).map((job) => ({
                id: job.id,
                job_no: job.job_no,
                label:
                  job.description?.trim() ||
                  job.job_kind.replace(/_/g, " "),
                location_id: job.location_id,
              }))}
            />
          </Card>
        </div>
      ) : null}

      {filterLabel ? (
        <FilterNote
          label={filterLabel}
          count={shown.length}
          clearHref="/purchasing/requests"
        />
      ) : null}

      <RequestList
        rows={shown.map((request) => ({
          id: request.id,
          request_no: request.request_no,
          justification: request.justification,
          lines: (request.purchase_request_lines ?? [])
            .map((line) => `${Number(line.quantity)}× ${line.description}`)
            .join(", "),
          locationCode: request.locations?.code ?? null,
          locationName: request.locations?.name ?? null,
          needed_by: request.needed_by,
          estimate: (request.purchase_request_lines ?? []).reduce(
            (sum, line) =>
              sum + Number(line.quantity) * Number(line.estimated_price),
            0,
          ),
          status: request.status,
        }))}
        canEdit={canEdit}
        submitAction={submitPurchaseRequest}
      />
    </>
  );
}
