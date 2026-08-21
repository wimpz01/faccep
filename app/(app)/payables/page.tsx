import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  EmptyState,
  FilterNote,
  PageHeader,
  StatTile,
  TabBar,
} from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { supplierRateMap, type TaxRate } from "@/lib/tax";

import {
  cancelVoucher,
  createSupplierInvoice,
  createVoucher,
  releaseVoucher,
  submitVoucherForApproval,
} from "./actions";
import { BillList } from "./bill-list";
import { isReversal, voucherKindLabel } from "./constants";
import {
  SupplierInvoiceForm,
  VoucherForm,
  VoucherRowActions,
  type InvoicePreload,
  type OpenBill,
} from "./payables-forms";

export const metadata: Metadata = { title: "Payables" };

type BillRow = {
  id: string;
  invoice_no: string;
  bill_no: string;
  locations: { code: string; name: string } | null;
  vendor_id: string;
  invoice_date: string;
  due_date: string;
  amount: string;
  vat_amount: string;
  withholding_tax: string;
  total: string;
  amount_paid: string;
  status: string;
  vendors: { name: string } | null;
  maintenance_jobs: { job_no: string; job_kind: string } | null;
};

type VoucherRow = {
  id: string;
  voucher_no: string;
  vendor_id: string;
  voucher_date: string;
  amount: string;
  check_no: string | null;
  bank: string | null;
  status: string;
  voucher_kind: string;
  payment_method: string | null;
  check_date: string | null;
  cleared_at: string | null;
  reverses_voucher_id: string | null;
  vendors: { name: string } | null;
  voucher_lines: { id: string }[];
};

type ReceiptPreloadRow = {
  id: string;
  receipt_no: string;
  received_date: string;
  company_id: string;
  purchase_orders: {
    id: string;
    po_no: string;
    vendor_id: string;
    location_id: string | null;
    vendors: { name: string } | null;
  } | null;
  goods_receipt_lines: {
    quantity: string;
    purchase_order_lines: {
      description: string;
      unit_price: string;
      inventory_items: {
        id: string;
        sku: string | null;
        unit_of_measure: string;
      } | null;
    } | null;
  }[];
};

const TAB_INVOICES = "invoices";
const TAB_RECEIPTS = "receipts";
const TAB_RECORD = "record";
const TAB_VOUCHERS = "vouchers";

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    view?: string;
    receipt?: string;
    sort?: string;
  }>;
}) {
  const { tab, view, receipt, sort } = await searchParams;
  const context = await requirePermission(MODULE.payablesInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canRecord = can(context.permissions, MODULE.payablesInvoices, "edit");
  const canPrepare = can(context.permissions, MODULE.payablesVouchers, "edit");
  const canRelease = can(context.permissions, MODULE.payablesPayments, "approve");
  // What the company spends per building is a management figure, not part of
  // the job of entering and settling bills. Same rule as stock value.
  const canSeeSpend = Boolean(
    context.isSuperAdmin || context.activeCompany?.isCompanyAdmin,
  );

  // Billing a receipt lands on the recording form with the goods already on it.
  const active = receipt
    ? TAB_RECORD
    : [TAB_INVOICES, TAB_RECEIPTS, TAB_RECORD, TAB_VOUCHERS].includes(tab ?? "")
      ? (tab as string)
      : TAB_INVOICES;

  const supabase = await createClient();
  const [
    { data: bills },
    { data: vouchers },
    { data: vendors },
    { data: expenseAccounts },
    { data: locations },
    { data: pendingVoucherApprovals },
    { data: stockItems },
    { data: nonStockItems },
    { data: rateRows },
  ] = await Promise.all([
    supabase
      .from("supplier_invoices")
      .select(
        "id, invoice_no, bill_no, vendor_id, invoice_date, due_date, amount, vat_amount, withholding_tax, total, amount_paid, status, vendors(name), locations(code, name), maintenance_jobs(job_no, job_kind)",
      )
      .eq("company_id", companyId)
      .order("due_date")
      .limit(200)
      .returns<BillRow[]>(),
    supabase
      .from("check_vouchers")
      .select(
        "id, voucher_no, vendor_id, voucher_date, amount, check_no, bank, status, voucher_kind, payment_method, check_date, cleared_at, reverses_voucher_id, vendors(name), voucher_lines(id)",
      )
      .eq("company_id", companyId)
      .order("voucher_date", { ascending: false })
      .limit(100)
      .returns<VoucherRow[]>(),
    supabase
      .from("vendors")
      .select("id, name, is_vatable, withholding")
      .eq("company_id", companyId)
      .eq("status", "approved")
      .order("name"),
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
    supabase
      .from("approval_requests")
      .select("entity_id")
      .eq("company_id", companyId)
      .eq("entity_table", "check_vouchers")
      .eq("status", "pending"),
    supabase
      .from("inventory_items")
      .select("id, sku, name, unit_of_measure, unit_cost")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    // Services carry the account they are charged to, so a bill line for one
    // never has to pick an account by hand.
    supabase
      .from("non_stock_items")
      .select("id, code, name, unit_of_measure, default_cost")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    // The withholding rates in force, so the voucher preview agrees with what
    // the ledger will actually post.
    supabase
      .from("tax_rates")
      .select("*")
      .eq("company_id", companyId)
      .returns<TaxRate[]>(),
  ]);

  const withholdingRates = supplierRateMap(rateRows ?? []);

  const awaitingApproval = new Set(
    (pendingVoucherApprovals ?? []).map((row) => row.entity_id as string),
  );

  // Goods that have arrived and not yet been billed. Each one carries what it
  // would put on an invoice: the items, at the quantities received and the
  // prices ordered.
  const [{ data: receiptRows }, { data: billedReceipts }] = await Promise.all([
    supabase
      .from("goods_receipts")
      .select(
        `id, receipt_no, received_date, company_id,
         purchase_orders(id, po_no, vendor_id, location_id, vendors(name)),
         goods_receipt_lines(quantity,
           purchase_order_lines(description, unit_price,
             inventory_items(id, sku, unit_of_measure)))`,
      )
      .eq("company_id", companyId)
      .order("received_date", { ascending: false })
      .limit(200)
      .returns<ReceiptPreloadRow[]>(),
    supabase
      .from("supplier_invoices")
      .select("receipt_id")
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .not("receipt_id", "is", null),
  ]);

  const billed = new Set(
    (billedReceipts ?? []).map((row) => row.receipt_id as string),
  );

  const unbilledReceipts: InvoicePreload[] = (receiptRows ?? [])
    .filter((row) => !billed.has(row.id))
    .map((row) => {
      const order = row.purchase_orders;
      const lines = (row.goods_receipt_lines ?? []).map((line) => ({
        item_id: line.purchase_order_lines?.inventory_items?.id ?? "",
        sku: line.purchase_order_lines?.inventory_items?.sku ?? "",
        description: line.purchase_order_lines?.description ?? "",
        unit_of_measure:
          line.purchase_order_lines?.inventory_items?.unit_of_measure ?? "pc",
        quantity: String(Number(line.quantity)),
        unit_price: String(Number(line.purchase_order_lines?.unit_price ?? 0)),
      }));
      return {
        receiptId: row.id,
        receiptNo: row.receipt_no,
        receivedDate: row.received_date,
        poId: order?.id ?? "",
        poNo: order?.po_no ?? "",
        vendorId: order?.vendor_id ?? "",
        vendorName: order?.vendors?.name ?? "Supplier",
        locationId: order?.location_id ?? "",
        value: round2(
          lines.reduce(
            (sum, line) => sum + Number(line.quantity) * Number(line.unit_price),
            0,
          ),
        ),
        lines,
      };
    });

  const unbilledValue = round2(
    unbilledReceipts.reduce((sum, row) => sum + row.value, 0),
  );

  const rows = bills ?? [];
  const today = new Date().toISOString().slice(0, 10);

  // Where the money actually went. Bills with no property are grouped rather
  // than dropped, so the rows always add up to the total billed.
  const propertyTotals = new Map<
    string,
    { key: string; label: string; count: number; billed: number; owing: number }
  >();
  for (const bill of rows) {
    if (bill.status === "cancelled") continue;
    const key = bill.locations ? bill.locations.code : "—";
    const entry = propertyTotals.get(key) ?? {
      key,
      label: bill.locations
        ? `${bill.locations.code} — ${bill.locations.name}`
        : "Company-wide",
      count: 0,
      billed: 0,
      owing: 0,
    };
    entry.count += 1;
    entry.billed += Number(bill.total);
    entry.owing += Number(bill.total) - Number(bill.amount_paid);
    propertyTotals.set(key, entry);
  }
  const byProperty = [...propertyTotals.values()].sort((a, b) =>
    b.billed - a.billed,
  );

  const open: OpenBill[] = rows
    .filter((bill) => bill.status === "open" || bill.status === "partially_paid")
    .map((bill) => ({
      id: bill.id,
      invoice_no: bill.invoice_no,
      vendor_id: bill.vendor_id,
      due_date: bill.due_date,
      outstanding: round2(Number(bill.total) - Number(bill.amount_paid)),
      jobNo: bill.maintenance_jobs?.job_no ?? null,
      // What share of the bill is VAT-exclusive, so tax withheld on a part
      // payment is worked out on the right base rather than on the gross.
      netShare:
        Number(bill.amount) + Number(bill.vat_amount) > 0
          ? Number(bill.amount) / (Number(bill.amount) + Number(bill.vat_amount))
          : 1,
      alreadyWithheld: Number(bill.withholding_tax) > 0,
    }))
    .filter((bill) => bill.outstanding > 0);

  const voucherRows = vouchers ?? [];

  // Postdated cheques we have handed to suppliers and not yet had honoured:
  // money committed but still in our account.
  const outgoingPostdated = voucherRows.filter(
    (v) =>
      v.voucher_kind === "prepayment" &&
      v.status !== "cancelled" &&
      !v.cleared_at,
  );
  const unmaturedOut = outgoingPostdated.filter(
    (v) => (v.check_date ?? "") > today,
  );
  const dueOut = outgoingPostdated.filter((v) => (v.check_date ?? "") <= today);
  const totalOf = (list: { amount: string }[]) =>
    list.reduce((total, row) => total + Number(row.amount), 0);

  // Vouchers a void or refund could be raised against.
  const reversedTotals = new Map<string, number>();
  for (const v of voucherRows) {
    if (!v.reverses_voucher_id || v.status === "cancelled") continue;
    reversedTotals.set(
      v.reverses_voucher_id,
      (reversedTotals.get(v.reverses_voucher_id) ?? 0) + Number(v.amount),
    );
  }
  const reversible = voucherRows
    .filter(
      (v) =>
        (v.voucher_kind === "payment" || v.voucher_kind === "prepayment") &&
        v.status === "released",
    )
    .map((v) => ({
      id: v.id,
      voucher_no: v.voucher_no,
      vendor_id: (v as unknown as { vendor_id: string }).vendor_id,
      amount: Number(v.amount),
      remaining: round2(Number(v.amount) - (reversedTotals.get(v.id) ?? 0)),
    }))
    .filter((v) => v.remaining > 0);

  // The tiles link here, so the list narrows to what the tile counted.
  const listedVouchers =
    view === "postdated" ? outgoingPostdated : voucherRows;

  const overdue = open.filter((bill) => bill.due_date < today);

  // Clicking a headline figure narrows the list below it to exactly what the
  // figure counted, rather than leaving the reader to find it.
  const openIds = new Set(open.map((bill) => bill.id));
  const overdueIds = new Set(overdue.map((bill) => bill.id));
  const shownBills =
    view === "outstanding"
      ? rows.filter((bill) => openIds.has(bill.id))
      : view === "overdue"
        ? rows.filter((bill) => overdueIds.has(bill.id))
        : view === "withheld"
          ? rows.filter((bill) => Number(bill.withholding_tax) > 0)
          : rows;
  const billFilterLabel =
    view === "outstanding"
      ? "invoices still outstanding"
      : view === "overdue"
        ? "invoices past their due date"
        : view === "withheld"
          ? "invoices with tax withheld"
          : null;

  /*
   * Ordered by the date the bill was raised, newest first, because a list of
   * transactions is nearly always read for the most recent one. Clicking the
   * column heading turns it around; the order lives in the URL, so the view
   * survives a refresh and can be sent to somebody else.
   *
   * Same-day bills fall back to their own number, which is issued in order --
   * without it a day's worth of bills would shuffle between page loads.
   */
  const dateAscending = sort === "date_asc";
  const sortedBills = [...shownBills].sort((a, b) => {
    const byDate = a.invoice_date.localeCompare(b.invoice_date);
    const settled = byDate !== 0 ? byDate : a.bill_no.localeCompare(b.bill_no);
    return dateAscending ? settled : -settled;
  });
  const dateSortHref = `/payables?tab=${TAB_INVOICES}${
    view ? `&view=${view}` : ""
  }&sort=${dateAscending ? "date_desc" : "date_asc"}`;
  const withheld = rows.reduce(
    (sum, bill) => sum + Number(bill.withholding_tax),
    0,
  );

  return (
    <>
      <PageHeader
        title="Payables"
        description="Supplier invoices and the cheque vouchers that settle them."
        action={
          canRecord ? (
            <Link
              href={`/payables?tab=${TAB_RECORD}`}
              className="btn btn-primary btn-sm"
            >
              + Add new invoice
            </Link>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Outstanding"
          value={money(open.reduce((sum, bill) => sum + bill.outstanding, 0))}
          hint={`${open.length} invoice(s)`}
          tone="money"
          href={`/payables?tab=${TAB_INVOICES}&view=outstanding`}
        />
        <StatTile
          label="Overdue"
          value={overdue.length}
          hint="Past the due date"
          href={`/payables?tab=${TAB_INVOICES}&view=overdue`}
        />
        <StatTile
          label="Received, not billed"
          value={money(unbilledValue)}
          hint={`${unbilledReceipts.length} delivery/deliveries awaiting an invoice`}
          tone="money"
          href={`/payables?tab=${TAB_RECEIPTS}`}
        />
        <StatTile
          label="Tax withheld"
          value={money(withheld)}
          hint="Creditable, for BIR 2307"
          href={`/payables?tab=${TAB_INVOICES}&view=withheld`}
        />
      </div>

      <TabBar
        active={active}
        tabs={[
          {
            value: TAB_INVOICES,
            label: "Supplier invoices",
            href: "/payables",
            count: rows.length,
          },
          {
            value: TAB_RECORD,
            label: "Record invoice",
            href: `/payables?tab=${TAB_RECORD}`,
          },
          {
            value: TAB_RECEIPTS,
            label: "Received, not billed",
            href: `/payables?tab=${TAB_RECEIPTS}`,
            count: unbilledReceipts.length,
          },
          {
            value: TAB_VOUCHERS,
            label: "Cheque vouchers",
            href: `/payables?tab=${TAB_VOUCHERS}`,
            count: (vouchers ?? []).length,
          },
        ]}
      />

      {active === TAB_RECEIPTS ? (
        <Card
          title="Delivered but not yet billed"
          description="Goods that have arrived against a purchase order with no supplier invoice recorded. Until one is, the cost is not in payables."
          bodyClassName=""
        >
          {unbilledReceipts.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Received</th>
                    <th>Supplier</th>
                    <th>Order</th>
                    <th>Items</th>
                    <th className="text-right">Value at order price</th>
                    <th className="text-right">Bill it</th>
                  </tr>
                </thead>
                <tbody>
                  {unbilledReceipts.map((row) => (
                    <tr key={row.receiptId}>
                      <td className="text-sm font-medium">{row.receiptNo}</td>
                      <td className="text-xs">{formatDate(row.receivedDate)}</td>
                      <td className="text-sm">{row.vendorName}</td>
                      <td className="text-xs">
                        <Link href={`/purchasing/orders/${row.poId}`}>
                          {row.poNo}
                        </Link>
                      </td>
                      <td className="text-xs">
                        {row.lines.length} line(s)
                        {row.lines[0]
                          ? ` — ${row.lines[0].description}${
                              row.lines.length > 1 ? "…" : ""
                            }`
                          : ""}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.value)}
                      </td>
                      <td className="text-right">
                        {canRecord ? (
                          <Link
                            href={`/payables?receipt=${row.receiptId}`}
                            className="btn btn-primary btn-sm"
                          >
                            Create supplier invoice
                          </Link>
                        ) : (
                          <span className="text-xs muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={5} className="text-right font-bold">
                      Not yet in payables
                    </td>
                    <td className="text-right tabular-nums font-bold">
                      {money(unbilledValue)}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>
              Everything received has been billed. Nothing is sitting in stock
              without a supplier invoice behind it.
            </EmptyState>
          )}
        </Card>
      ) : null}

      {active === TAB_RECORD ? (
        canRecord ? (
          <Card
            title="Record a supplier invoice"
            description="Line prices are VAT-inclusive, the way a supplier quotes them. The VATable base, VAT and any withholding are worked out from them."
          >
            <SupplierInvoiceForm
              action={createSupplierInvoice}
              vendors={vendors ?? []}
              expenseAccounts={expenseAccounts ?? []}
              locations={locations ?? []}
              items={stockItems ?? []}
              nonStock={nonStockItems ?? []}
              receipts={unbilledReceipts}
              initialReceiptId={receipt}
            />
          </Card>
        ) : (
          <Card title="Record a supplier invoice">
            <EmptyState>
              You do not have Edit on supplier invoices.
            </EmptyState>
          </Card>
        )
      ) : null}

      {active === TAB_VOUCHERS ? (
        <div className="grid gap-4 sm:grid-cols-2 mb-6">
          <StatTile
            label="Postdated, not yet matured"
            value={money(totalOf(unmaturedOut))}
            hint={`${unmaturedOut.length} cheque(s) we have issued`}
            tone="money"
            href={`/payables?tab=${TAB_VOUCHERS}&view=postdated`}
          />
          <StatTile
            label="Our cheques now due"
            value={money(totalOf(dueOut))}
            hint={
              dueOut.length > 0
                ? `${dueOut.length} reached their date`
                : "Nothing of ours is due"
            }
            href={`/payables?tab=${TAB_VOUCHERS}&view=postdated`}
          />
        </div>
      ) : null}

      {active === TAB_VOUCHERS && canPrepare ? (
        <div className="mb-6">
          <Card title="Prepare a cheque voucher">
            <VoucherForm
              action={createVoucher}
              vendors={vendors ?? []}
              bills={open}
              reversible={reversible}
              withholdingRates={withholdingRates}
            />
          </Card>
        </div>
      ) : null}

      {active === TAB_INVOICES && canSeeSpend && byProperty.length > 0 ? (
        <div className="mb-6">
          <Card
            title="Spend by property"
            description="Billed by suppliers, charged to the property the purchase was raised for."
            bodyClassName=""
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th className="text-right">Bills</th>
                    <th className="text-right">Billed</th>
                    <th className="text-right">Still owing</th>
                  </tr>
                </thead>
                <tbody>
                  {byProperty.map((row) => (
                    <tr key={row.key}>
                      <td className="text-sm">{row.label}</td>
                      <td className="text-right tabular-nums">{row.count}</td>
                      <td className="text-right tabular-nums">
                        {money(row.billed)}
                      </td>
                      <td className="text-right tabular-nums">
                        {money(row.owing)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-semibold">All properties</td>
                    <td className="text-right tabular-nums font-semibold">
                      {rows.length}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(byProperty.reduce((sum, row) => sum + row.billed, 0))}
                    </td>
                    <td className="text-right tabular-nums font-semibold">
                      {money(byProperty.reduce((sum, row) => sum + row.owing, 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {active === TAB_INVOICES && billFilterLabel ? (
        <FilterNote
          label={billFilterLabel}
          count={shownBills.length}
          clearHref={`/payables?tab=${TAB_INVOICES}`}
        />
      ) : null}

      {active === TAB_INVOICES ? (
        <Card title="Supplier invoices" bodyClassName="">
          <BillList
            dateSortHref={dateSortHref}
            dateAscending={dateAscending}
            rows={sortedBills.map((bill) => {
              const balance = round2(
                Number(bill.total) - Number(bill.amount_paid),
              );
              return {
                id: bill.id,
                bill_no: bill.bill_no,
                invoice_no: bill.invoice_no,
                supplier: bill.vendors?.name ?? "—",
                locationLabel: bill.locations
                  ? bill.locations.code
                  : "Company-wide",
                jobLabel: bill.maintenance_jobs?.job_no
                  ? `${bill.maintenance_jobs.job_no} (${bill.maintenance_jobs.job_kind})`
                  : null,
                invoice_date: bill.invoice_date,
                due_date: bill.due_date,
                total: Number(bill.total),
                paid: Number(bill.amount_paid),
                balance,
                status: bill.status,
                isOverdue:
                  balance > 0 &&
                  bill.due_date < today &&
                  bill.status !== "paid",
              };
            })}
          />
        </Card>
      ) : null}

      {active === TAB_VOUCHERS ? (
        <Card
          title={
            view === "postdated" ? "Postdated cheques we have issued" : "Cheque vouchers"
          }
          description={
            view === "postdated" ? "Handed over and not yet honoured." : undefined
          }
          action={
            view === "postdated" ? (
              <a href="/payables?tab=vouchers" className="btn btn-secondary btn-sm">
                Show all
              </a>
            ) : undefined
          }
          bodyClassName=""
        >
        {listedVouchers.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Voucher</th>
                  <th>Type</th>
                  <th>Supplier</th>
                  <th>Date</th>
                  <th>Cheque</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  {canRelease || canPrepare ? (
                    <th className="text-right">Action</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {listedVouchers.map((voucher) => (
                  <tr key={voucher.id}>
                    <td>
                      <Link
                        href={`/payables/vouchers/${voucher.id}`}
                        className="text-sm font-semibold"
                        style={{ color: "var(--color-brand-600)" }}
                      >
                        {voucher.voucher_no}
                      </Link>
                    </td>
                    <td className="text-xs">
                      <span
                        className={
                          isReversal(voucher.voucher_kind)
                            ? "badge"
                            : "badge badge-brand"
                        }
                        style={
                          isReversal(voucher.voucher_kind)
                            ? { color: "var(--danger)" }
                            : undefined
                        }
                      >
                        {voucherKindLabel(voucher.voucher_kind)}
                      </span>
                      {voucher.voucher_kind === "prepayment" &&
                      voucher.check_date ? (
                        <p className="muted mt-0.5">
                          matures {formatDate(voucher.check_date)}
                        </p>
                      ) : voucher.payment_method ? (
                        <p className="muted mt-0.5">{voucher.payment_method}</p>
                      ) : null}
                    </td>
                    <td className="text-sm">{voucher.vendors?.name ?? "—"}</td>
                    <td className="text-xs">{formatDate(voucher.voucher_date)}</td>
                    <td className="text-xs">
                      {voucher.check_no ?? "—"}
                      {voucher.bank ? <p className="muted">{voucher.bank}</p> : null}
                    </td>
                    <td className="text-right tabular-nums">{money(voucher.amount)}</td>
                    <td>
                      <span
                        className={
                          voucher.status === "released" ? "badge badge-brand" : "badge"
                        }
                      >
                        {voucher.status}
                      </span>
                    </td>
                    <td className="text-right">
                      <VoucherRowActions
                        voucherId={voucher.id}
                        status={voucher.status}
                        kind={voucher.voucher_kind}
                        hasLines={(voucher.voucher_lines ?? []).length > 0}
                        awaitingApproval={awaitingApproval.has(voucher.id)}
                        canPrepare={canPrepare}
                        canRelease={canRelease}
                        submitAction={submitVoucherForApproval}
                        releaseAction={releaseVoucher}
                        cancelAction={cancelVoucher}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>
            {view === "postdated"
              ? "No postdated cheques outstanding."
              : "No vouchers prepared yet."}
          </EmptyState>
        )}
        </Card>
      ) : null}
    </>
  );
}
