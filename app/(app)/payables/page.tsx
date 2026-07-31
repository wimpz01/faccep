import type { Metadata } from "next";

import { Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  cancelVoucher,
  createSupplierInvoice,
  createVoucher,
  releaseVoucher,
} from "./actions";
import { SupplierInvoiceForm, VoucherForm, type OpenBill } from "./payables-forms";

export const metadata: Metadata = { title: "Payables" };

type BillRow = {
  id: string;
  invoice_no: string;
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
  voucher_date: string;
  amount: string;
  check_no: string | null;
  bank: string | null;
  status: string;
  vendors: { name: string } | null;
};

export default async function PayablesPage() {
  const context = await requirePermission(MODULE.payablesInvoices, "view");
  const companyId = context.activeCompany!.companyId;
  const canRecord = can(context.permissions, MODULE.payablesInvoices, "edit");
  const canPrepare = can(context.permissions, MODULE.payablesVouchers, "edit");
  const canRelease = can(context.permissions, MODULE.payablesPayments, "approve");

  const supabase = await createClient();
  const [
    { data: bills },
    { data: vouchers },
    { data: vendors },
    { data: expenseAccounts },
  ] = await Promise.all([
    supabase
      .from("supplier_invoices")
      .select(
        "id, invoice_no, vendor_id, invoice_date, due_date, amount, vat_amount, withholding_tax, total, amount_paid, status, vendors(name), maintenance_jobs(job_no, job_kind)",
      )
      .eq("company_id", companyId)
      .order("due_date")
      .limit(200)
      .returns<BillRow[]>(),
    supabase
      .from("check_vouchers")
      .select(
        "id, voucher_no, voucher_date, amount, check_no, bank, status, vendors(name)",
      )
      .eq("company_id", companyId)
      .order("voucher_date", { ascending: false })
      .limit(100)
      .returns<VoucherRow[]>(),
    supabase
      .from("vendors")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("chart_of_accounts")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("account_type", "expense")
      .eq("is_active", true)
      .order("code"),
  ]);

  const rows = bills ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const open: OpenBill[] = rows
    .filter((bill) => bill.status === "open" || bill.status === "partially_paid")
    .map((bill) => ({
      id: bill.id,
      invoice_no: bill.invoice_no,
      vendor_id: bill.vendor_id,
      due_date: bill.due_date,
      outstanding: round2(Number(bill.total) - Number(bill.amount_paid)),
      jobNo: bill.maintenance_jobs?.job_no ?? null,
    }))
    .filter((bill) => bill.outstanding > 0);

  const overdue = open.filter((bill) => bill.due_date < today);
  const withheld = rows.reduce(
    (sum, bill) => sum + Number(bill.withholding_tax),
    0,
  );

  return (
    <>
      <PageHeader
        title="Payables"
        description="Supplier invoices and the cheque vouchers that settle them."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Outstanding"
          value={money(open.reduce((sum, bill) => sum + bill.outstanding, 0))}
          hint={`${open.length} invoice(s)`}
          tone="money"
        />
        <StatTile label="Overdue" value={overdue.length} hint="Past the due date" />
        <StatTile
          label="Tax withheld"
          value={money(withheld)}
          hint="Creditable, for BIR 2307"
        />
        <StatTile
          label="Vouchers"
          value={(vouchers ?? []).filter((v) => v.status !== "released").length}
          hint="Prepared, not yet released"
        />
      </div>

      {canRecord ? (
        <div className="mb-6">
          <Card
            title="Record a supplier invoice"
            description="The payable is net of creditable withholding tax, which is remitted to the BIR rather than the supplier."
          >
            <SupplierInvoiceForm
              action={createSupplierInvoice}
              vendors={vendors ?? []}
              expenseAccounts={expenseAccounts ?? []}
            />
          </Card>
        </div>
      ) : null}

      {canPrepare ? (
        <div className="mb-6">
          <Card title="Prepare a cheque voucher">
            <VoucherForm
              action={createVoucher}
              vendors={vendors ?? []}
              bills={open}
            />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card title="Supplier invoices" bodyClassName="">
          {rows.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Supplier</th>
                    <th>Due</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Balance</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bill) => {
                    const balance = round2(
                      Number(bill.total) - Number(bill.amount_paid),
                    );
                    const isOverdue =
                      balance > 0 && bill.due_date < today && bill.status !== "paid";
                    return (
                      <tr key={bill.id}>
                        <td>
                          <span className="font-medium text-sm">
                            {bill.invoice_no}
                          </span>
                          {bill.maintenance_jobs?.job_no ? (
                            <p className="text-xs muted">
                              {bill.maintenance_jobs.job_no} (
                              {bill.maintenance_jobs.job_kind})
                            </p>
                          ) : null}
                        </td>
                        <td className="text-sm">{bill.vendors?.name ?? "—"}</td>
                        <td className="text-xs">
                          {formatDate(bill.due_date)}
                          {isOverdue ? (
                            <p style={{ color: "var(--danger)" }}>overdue</p>
                          ) : null}
                        </td>
                        <td className="text-right tabular-nums">{money(bill.total)}</td>
                        <td className="text-right tabular-nums">
                          {money(bill.amount_paid)}
                        </td>
                        <td className="text-right tabular-nums">{money(balance)}</td>
                        <td>
                          <span className="badge">
                            {bill.status.replace("_", " ")}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No supplier invoices recorded yet.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Cheque vouchers" bodyClassName="">
        {vouchers && vouchers.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Voucher</th>
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
                {vouchers.map((voucher) => (
                  <tr key={voucher.id}>
                    <td className="text-sm font-medium">{voucher.voucher_no}</td>
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
                    {canRelease || canPrepare ? (
                      <td className="text-right">
                        {voucher.status !== "released" &&
                        voucher.status !== "cancelled" ? (
                          <div className="inline-flex gap-2">
                            {canRelease ? (
                              <form action={releaseVoucher}>
                                <input type="hidden" name="id" value={voucher.id} />
                                <button
                                  type="submit"
                                  className="btn btn-secondary btn-sm"
                                >
                                  Release
                                </button>
                              </form>
                            ) : null}
                            {canPrepare ? (
                              <form action={cancelVoucher}>
                                <input type="hidden" name="id" value={voucher.id} />
                                <button type="submit" className="btn btn-danger btn-sm">
                                  Cancel
                                </button>
                              </form>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No vouchers prepared yet.</EmptyState>
        )}
      </Card>
    </>
  );
}
