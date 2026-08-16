import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  EmptyState,
  FilterNote,
  PageHeader,
  StatTile,
} from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import { generateInvoices, releaseInvoices } from "./actions";
import { STATUS_BADGE } from "./constants";
import { GenerateForm, InvoiceTable } from "./invoice-forms";

export const metadata: Metadata = { title: "Invoices" };

type InvoiceRow = {
  id: string;
  invoice_no: string;
  status: string;
  invoice_date: string;
  due_date: string;
  total: string;
  amount_paid: string;
  credited_amount: string;
  location_id: string | null;
  tenants: { company_name: string } | null;
  locations: { code: string } | null;
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    view?: string;
    location?: string;
    sort?: string;
  }>;
}) {
  const { status, view, location, sort } = await searchParams;
  const context = await requirePermission(MODULE.billingInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.billingInvoices, "edit");
  // Releasing posts to the ledger, so it is gated on approve, not edit.
  const canApprove = can(context.permissions, MODULE.billingInvoices, "approve");

  const supabase = await createClient();
  let query = supabase
    .from("invoices")
    .select(
      "id, invoice_no, status, invoice_date, due_date, total, amount_paid, credited_amount, location_id, tenants(company_name), locations(code)",
    )
    .eq("company_id", companyId);

  // Both filters narrow the same query, so they combine rather than replace
  // one another; the search box then narrows what they return.
  if (status) query = query.eq("status", status);
  if (location) query = query.eq("location_id", location);

  /*
   * Ordering happens in the query, like the filters, so the two hundred rows
   * fetched are the right two hundred. Sorting the page in the browser would
   * only reorder whatever the cap happened to catch.
   *
   * Newest first is the default because that is what somebody opening the list
   * is usually looking for.
   */
  const sortKey = sort === "no_asc" || sort === "no_desc" ? "invoice_no" : "invoice_date";
  const ascending = sort === "date_asc" || sort === "no_asc";

  const [{ data: invoices }, { data: locationOptions }, { data: allOpen }] =
    await Promise.all([
      query
        .order(sortKey, { ascending })
        // A tie on the day is broken by the number, so the order is stable
        // rather than left to whatever the database returns first.
        .order("invoice_no", { ascending })
        .limit(200)
        .returns<InvoiceRow[]>(),
      supabase
        .from("locations")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("code")
        .returns<{ id: string; code: string; name: string }[]>(),
      /*
       * The tiles answer for the whole company, not for whatever the list is
       * currently filtered to. Read separately for that reason: computing them
       * from the filtered rows made "Outstanding" fall to nought the moment
       * anybody clicked Drafts, which read as a figure rather than a filter.
       */
      supabase
        .from("invoices")
        .select("status, due_date, total, amount_paid, credited_amount")
        .eq("company_id", companyId)
        .returns<
          {
            status: string;
            due_date: string;
            total: string;
            amount_paid: string;
            credited_amount: string;
          }[]
        >(),
    ]);

  const rows = invoices ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const companyRows = allOpen ?? [];
  const isLive = (row: { status: string }) =>
    row.status === "released" || row.status === "partially_paid";

  const outstanding = companyRows
    .filter(isLive)
    .reduce(
      (sum, row) =>
        sum +
        (Number(row.total) - Number(row.amount_paid) - Number(row.credited_amount)),
      0,
    );
  const overdueCount = companyRows.filter(
    (row) => isLive(row) && row.due_date < today,
  ).length;
  const draftCount = companyRows.filter((row) => row.status === "draft").length;

  // Overdue is not a status, so it narrows the list here rather than in the
  // query the status buttons drive.
  const byView =
    view === "overdue"
      ? rows.filter((row) => isLive(row) && row.due_date < today)
      : rows;

  // Every filter and the sort travel together in the URL, so changing one
  // keeps the rest rather than resetting the list.
  const filterHref = (next: {
    status?: string;
    location?: string;
    view?: string;
    sort?: string;
  }) => {
    const params = new URLSearchParams();
    const merged = { status, location, view, sort, ...next };
    if (merged.status) params.set("status", merged.status);
    if (merged.location) params.set("location", merged.location);
    if (merged.view) params.set("view", merged.view);
    if (merged.sort) params.set("sort", merged.sort);
    const query = params.toString();
    return query ? `/billing/invoices?${query}` : "/billing/invoices";
  };

  // Clicking the column you are already sorted by turns it round.
  const dateAscending = sort === "date_asc";
  const numberSorted = sortKey === "invoice_no";
  const numberAscending = sort === "no_asc";

  const locationName = locationOptions?.find((row) => row.id === location)?.code;


  return (
    <>
      <PageHeader
        title="Invoices"
        description="Generated from contracts and meter readings. Once released, an invoice is locked."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Outstanding"
          value={money(outstanding)}
          hint="Released and unpaid, all locations"
          tone="money"
          href="/billing/invoices?status=released"
        />
        <StatTile
          label="Overdue"
          value={overdueCount}
          hint="Past the due date, all locations"
          href="/billing/invoices?view=overdue"
        />
        <StatTile
          label="Drafts"
          value={draftCount}
          hint="Not yet released, all locations"
          href="/billing/invoices?status=draft"
        />
        <StatTile
          label="Total shown"
          value={byView.length}
          hint={
            location || status || view
              ? "Matching the filters below"
              : "Most recent 200"
          }
          href="/billing/invoices"
        />
      </div>

      {view === "overdue" ? (
        <FilterNote
          label="invoices past their due date"
          count={byView.length}
          clearHref={filterHref({ view: undefined })}
        />
      ) : null}

      {canEdit ? (
        <div className="mb-6">
          <Card
            title="Generate a month's invoices"
            description="One draft per active contract in the locations you pick: rent with escalation, metered utilities, each utility's building expense shared out, and any late penalty."
          >
            <GenerateForm
              action={generateInvoices}
              locations={locationOptions ?? []}
            />
          </Card>
        </div>
      ) : null}

      <Card
        title="Invoices"
        action={
          <div className="flex flex-col gap-2 items-end">
            <div className="flex gap-2 flex-wrap">
              {[
                ["", "All"],
                ["draft", "Drafts"],
                ["released", "Released"],
                ["partially_paid", "Part paid"],
                ["paid", "Paid"],
                ["cancelled", "Cancelled"],
              ].map(([value, label]) => (
                <Link
                  key={value || "all"}
                  href={filterHref({ status: value || undefined })}
                  className={`btn btn-sm ${status === value || (!status && !value) ? "btn-primary" : "btn-secondary"}`}
                >
                  {label}
                </Link>
              ))}
            </div>
            {/* Same control as the statuses, so the two read as one set of
                filters that narrow together rather than replace each other. */}
            <div className="flex gap-2 flex-wrap">
              <Link
                href={filterHref({ location: undefined })}
                className={`btn btn-sm ${!location ? "btn-primary" : "btn-secondary"}`}
              >
                All locations
              </Link>
              {(locationOptions ?? []).map((option) => (
                <Link
                  key={option.id}
                  href={filterHref({ location: option.id })}
                  className={`btn btn-sm ${location === option.id ? "btn-primary" : "btn-secondary"}`}
                  title={option.name}
                >
                  {option.code}
                </Link>
              ))}
            </div>
          </div>
        }
        bodyClassName=""
      >
        {byView.length > 0 ? (
          <InvoiceTable
            numberSortHref={filterHref({
              sort: numberSorted && numberAscending ? "no_desc" : "no_asc",
            })}
            dateSortHref={filterHref({
              sort: !numberSorted && dateAscending ? "date_desc" : "date_asc",
            })}
            numberSorted={numberSorted}
            numberAscending={numberAscending}
            dateSorted={!numberSorted}
            dateAscending={dateAscending}
            rows={byView.map((invoice) => ({
              id: invoice.id,
              invoice_no: invoice.invoice_no,
              tenant: invoice.tenants?.company_name ?? "—",
              location: invoice.locations?.code ?? "—",
              invoice_date: invoice.invoice_date,
              due_date: invoice.due_date,
              total: Number(invoice.total),
              balance:
                Number(invoice.total) -
                Number(invoice.amount_paid) -
                Number(invoice.credited_amount),
              status: invoice.status,
              isOverdue:
                (invoice.status === "released" ||
                  invoice.status === "partially_paid") &&
                invoice.due_date < today,
            }))}
            action={releaseInvoices}
            canRelease={canApprove}
          />
        ) : (
          <EmptyState>
            No invoices match this filter
            {locationName ? ` in ${locationName}` : ""}.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
