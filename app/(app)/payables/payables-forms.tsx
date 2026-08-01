"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";

import type { ActionState } from "./actions";

export type VendorOption = { id: string; name: string };
export type OpenBill = {
  id: string;
  invoice_no: string;
  vendor_id: string;
  due_date: string;
  outstanding: number;
  jobNo: string | null;
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

function Result({ state }: { state: ActionState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </>
  );
}

export type ExpenseAccountOption = { id: string; code: string; name: string };

export function SupplierInvoiceForm({
  action,
  vendors,
  expenseAccounts,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendors: VendorOption[];
  expenseAccounts: ExpenseAccountOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [amount, setAmount] = useState("");
  const [vat, setVat] = useState("");
  const [withholding, setWithholding] = useState("");

  const total = round2(
    (Number(amount) || 0) + (Number(vat) || 0) - (Number(withholding) || 0),
  );

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <div>
        <label className="label" htmlFor="si-vendor">
          Supplier *
        </label>
        <select id="si-vendor" name="vendor_id" className="select" required defaultValue="">
          <option value="">Choose…</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="si-no">
          Supplier&rsquo;s invoice no. *
        </label>
        <input id="si-no" name="invoice_no" className="input" required />
        <p className="text-xs muted mt-1">
          Their reference. Ours is issued on save.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="si-date">
          Invoice date *
        </label>
        <input
          id="si-date"
          name="invoice_date"
          type="date"
          className="input"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>
      <div>
        <label className="label" htmlFor="si-due">
          Due date *
        </label>
        <input
          id="si-due"
          name="due_date"
          type="date"
          className="input"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </div>

      <div>
        <label className="label" htmlFor="si-amount">
          Net amount (₱) *
        </label>
        <input
          id="si-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          required
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="si-vat">
          VAT (₱)
        </label>
        <input
          id="si-vat"
          name="vat_amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          value={vat}
          onChange={(event) => setVat(event.currentTarget.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="si-ewt">
          Withholding tax (₱)
        </label>
        <input
          id="si-ewt"
          name="withholding_tax"
          type="number"
          step="0.01"
          min="0"
          className="input"
          value={withholding}
          onChange={(event) => setWithholding(event.currentTarget.value)}
        />
        <p className="text-xs muted mt-1">Feeds BIR 2307.</p>
      </div>
      <div>
        <p className="label">Payable to supplier</p>
        <p
          className="text-lg font-bold tabular-nums"
          style={{ color: "var(--color-gold-500)" }}
        >
          {money(total)}
        </p>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="si-expense">
          Charge to
        </label>
        <select
          id="si-expense"
          name="expense_account_id"
          className="select"
          defaultValue=""
        >
          <option value="">Default expense account</option>
          {expenseAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
        <p className="text-xs muted mt-1">
          For services and utilities bought without a purchase order.
        </p>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="si-notes">
          Notes
        </label>
        <input id="si-notes" name="notes" className="input" />
      </div>

      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Record invoice" />
        <Result state={state} />
      </div>
    </form>
  );
}

/**
 * Bill raised from a purchase order. The billable amount is what has been
 * received less what has already been billed, so the three facts stay matched.
 */
export function BillFromOrderForm({
  action,
  poId,
  poNo,
  vendorName,
  billable,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  poId: string;
  poNo: string;
  vendorName: string;
  billable: number;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [amount, setAmount] = useState(billable.toFixed(2));
  const [vat, setVat] = useState("");
  const [withholding, setWithholding] = useState("");

  const total = round2(
    (Number(amount) || 0) + (Number(vat) || 0) - (Number(withholding) || 0),
  );
  const over = (Number(amount) || 0) > billable;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-4">
      <input type="hidden" name="po_id" value={poId} />

      <div className="sm:col-span-4">
        <p className="text-sm">
          Billing <strong>{poNo}</strong> from {vendorName}. Received and not yet
          billed: <strong>{money(billable)}</strong>.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="bill-no">
          Supplier&rsquo;s invoice no. *
        </label>
        <input id="bill-no" name="invoice_no" className="input" required />
        <p className="text-xs muted mt-1">
          Their reference. Ours is issued on save.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="bill-date">
          Invoice date *
        </label>
        <input
          id="bill-date"
          name="invoice_date"
          type="date"
          className="input"
          required
          defaultValue={today}
        />
      </div>
      <div>
        <label className="label" htmlFor="bill-due">
          Due date *
        </label>
        <input
          id="bill-due"
          name="due_date"
          type="date"
          className="input"
          required
          defaultValue={today}
        />
      </div>
      <div>
        <label className="label" htmlFor="bill-amount">
          Net amount (₱) *
        </label>
        <input
          id="bill-amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={billable}
          className="input"
          required
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
        {over ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            More than has been received.
          </p>
        ) : null}
      </div>

      <div>
        <label className="label" htmlFor="bill-vat">
          VAT (₱)
        </label>
        <input
          id="bill-vat"
          name="vat_amount"
          type="number"
          step="0.01"
          min="0"
          className="input"
          value={vat}
          onChange={(event) => setVat(event.currentTarget.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="bill-ewt">
          Withholding tax (₱)
        </label>
        <input
          id="bill-ewt"
          name="withholding_tax"
          type="number"
          step="0.01"
          min="0"
          className="input"
          value={withholding}
          onChange={(event) => setWithholding(event.currentTarget.value)}
        />
      </div>
      <div>
        <p className="label">Payable to supplier</p>
        <p
          className="text-lg font-bold tabular-nums"
          style={{ color: "var(--color-gold-500)" }}
        >
          {money(total)}
        </p>
      </div>
      <div>
        <label className="label" htmlFor="bill-notes">
          Notes
        </label>
        <input id="bill-notes" name="notes" className="input" />
      </div>

      <div className="sm:col-span-4 flex items-center gap-3 flex-wrap">
        <Submit label="Record bill" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function VoucherForm({
  action,
  vendors,
  bills,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendors: VendorOption[];
  bills: OpenBill[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [vendorId, setVendorId] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const vendorBills = useMemo(
    () => bills.filter((bill) => bill.vendor_id === vendorId),
    [bills, vendorId],
  );

  const total = round2(
    Object.entries(amounts)
      .filter(([id]) => vendorBills.some((bill) => bill.id === id))
      .reduce((sum, [, value]) => sum + (Number(value) || 0), 0),
  );

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="cv-vendor">
          Supplier *
        </label>
        <select
          id="cv-vendor"
          name="vendor_id"
          className="select"
          required
          value={vendorId}
          onChange={(event) => {
            setVendorId(event.currentTarget.value);
            setAmounts({});
          }}
        >
          <option value="">Choose…</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="cv-bank">
          Bank
        </label>
        <input id="cv-bank" name="bank" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="cv-check">
          Cheque number
        </label>
        <input id="cv-check" name="check_no" className="input" />
      </div>

      {vendorId ? (
        <div className="sm:col-span-3">
          {vendorBills.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th>Job</th>
                    <th className="text-right">Outstanding</th>
                    <th className="text-right" style={{ width: "10rem" }}>
                      Paying now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vendorBills.map((bill) => (
                    <tr key={bill.id}>
                      <td className="text-sm">{bill.invoice_no}</td>
                      <td className="text-xs">{formatDate(bill.due_date)}</td>
                      <td className="text-xs">{bill.jobNo ?? "—"}</td>
                      <td className="text-right tabular-nums">
                        {money(bill.outstanding)}
                      </td>
                      <td className="text-right">
                        <input
                          name={`pay:${bill.id}`}
                          type="number"
                          step="0.01"
                          min="0"
                          max={bill.outstanding}
                          className="input tabular-nums"
                          style={{ textAlign: "right" }}
                          value={amounts[bill.id] ?? ""}
                          onChange={(event) => {
                            // currentTarget is null by the time the updater
                            // runs, so take the value now.
                            const value = event.currentTarget.value;
                            setAmounts((current) => ({
                              ...current,
                              [bill.id]: value,
                            }));
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} className="text-right font-semibold">
                      Voucher total
                    </td>
                    <td />
                    <td className="text-right tabular-nums font-semibold">
                      {money(total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm muted">Nothing outstanding for this supplier.</p>
          )}
        </div>
      ) : null}

      <div className="sm:col-span-3">
        <label className="label" htmlFor="cv-notes">
          Notes
        </label>
        <input id="cv-notes" name="notes" className="input" />
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Prepare voucher" />
        <Result state={state} />
        <p className="text-xs muted">
          Contracted-job invoices are refused unless an approved percent-complete
          tranche covers them.
        </p>
      </div>
    </form>
  );
}
