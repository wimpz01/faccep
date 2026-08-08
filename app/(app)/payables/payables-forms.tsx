"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { round2 } from "@/lib/billing";
import { formatDate, money } from "@/lib/format";

import { withholdingRate } from "@/app/(app)/purchasing/constants";

import type { ActionState } from "./actions";
import {
  CHARGE_KINDS,
  PAYMENT_METHODS,
  VOUCHER_KINDS,
  isReversal,
  splitInvoiceTax,
} from "./constants";

export type VendorOption = {
  id: string;
  name: string;
  is_vatable?: boolean;
  withholding?: string;
};
export type OpenBill = {
  id: string;
  invoice_no: string;
  vendor_id: string;
  due_date: string;
  outstanding: number;
  jobNo: string | null;
  /** VAT-exclusive share of the bill, for working out tax to withhold. */
  netShare: number;
  /** Withholding was already taken when the bill was recorded. */
  alreadyWithheld: boolean;
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

export type LocationOption = { id: string; code: string; name: string };

export type NonStockOption = {
  id: string;
  code: string;
  name: string;
  unit_of_measure: string;
  default_cost: string;
};

export type StockItemOption = {
  id: string;
  sku: string | null;
  name: string;
  unit_of_measure: string;
  unit_cost: string;
};

/** A line as it is being typed, before it becomes an invoice line. */
export type InvoiceLineDraft = {
  key: string;
  item_id: string;
  non_stock_item_id: string;
  sku: string;
  description: string;
  unit_of_measure: string;
  quantity: string;
  unit_price: string;
};

let draftCounter = 0;
function blankLine(): InvoiceLineDraft {
  draftCounter += 1;
  return {
    key: `line-${draftCounter}`,
    item_id: "",
    non_stock_item_id: "",
    sku: "",
    description: "",
    unit_of_measure: "pc",
    quantity: "1",
    unit_price: "",
  };
}

/** What a goods receipt hands over when a bill is raised from it. */
export type InvoicePreload = {
  receiptId: string;
  receiptNo: string;
  receivedDate: string;
  poId: string;
  poNo: string;
  vendorId: string;
  vendorName: string;
  locationId: string;
  value: number;
  lines: {
    item_id: string;
    sku: string;
    description: string;
    unit_of_measure: string;
    quantity: string;
    unit_price: string;
  }[];
};

export function SupplierInvoiceForm({
  action,
  vendors,
  expenseAccounts,
  locations,
  items,
  nonStock,
  receipts,
  initialReceiptId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendors: VendorOption[];
  expenseAccounts: ExpenseAccountOption[];
  locations: LocationOption[];
  items: StockItemOption[];
  nonStock: NonStockOption[];
  receipts: InvoicePreload[];
  initialReceiptId?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [receiptId, setReceiptId] = useState(initialReceiptId ?? "");

  const preload = receipts.find((row) => row.receiptId === receiptId);

  const [vendorId, setVendorId] = useState(preload?.vendorId ?? "");
  const [locationId, setLocationId] = useState(preload?.locationId ?? "");
  const [chargeKind, setChargeKind] = useState("none");
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() =>
    preload && preload.lines.length > 0
      ? preload.lines.map((line) => ({ ...blankLine(), ...line }))
      : [blankLine()],
  );

  /**
   * Attaching a delivery replaces what is on the form with what arrived. The
   * supplier and property come from the order, so they stop being a choice.
   */
  function attachReceipt(nextId: string) {
    setReceiptId(nextId);
    const picked = receipts.find((row) => row.receiptId === nextId);
    if (!picked) {
      setLines([blankLine()]);
      return;
    }
    setVendorId(picked.vendorId);
    setLocationId(picked.locationId);
    setLines(
      picked.lines.length > 0
        ? picked.lines.map((line) => ({ ...blankLine(), ...line }))
        : [blankLine()],
    );
  }

  const vendor = vendors.find((row) => row.id === vendorId);

  const gross = round2(
    lines.reduce(
      (sum, line) =>
        sum + (Number(line.quantity) || 0) * (Number(line.unit_price) || 0),
      0,
    ),
  );
  const split = splitInvoiceTax(gross, vendor?.is_vatable ?? false, chargeKind);

  function updateLine(key: string, patch: Partial<InvoiceLineDraft>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  /** Choosing an item or a service fills in what it already knows. */
  function pickItem(key: string, value: string) {
    // Services are prefixed so one dropdown can offer both.
    if (value.startsWith("ns:")) {
      const service = nonStock.find((row) => row.id === value.slice(3));
      if (!service) return;
      updateLine(key, {
        item_id: "",
        non_stock_item_id: service.id,
        sku: service.code,
        description: service.name,
        unit_of_measure: service.unit_of_measure,
        unit_price:
          Number(service.default_cost) > 0 ? String(service.default_cost) : "",
      });
      return;
    }

    const item = items.find((row) => row.id === value);
    if (!item) {
      updateLine(key, { item_id: "", non_stock_item_id: "", sku: "" });
      return;
    }
    updateLine(key, {
      item_id: item.id,
      non_stock_item_id: "",
      sku: item.sku ?? "",
      description: item.name,
      unit_of_measure: item.unit_of_measure,
      unit_price: Number(item.unit_cost) > 0 ? String(item.unit_cost) : "",
    });
  }

  const payload = JSON.stringify(
    lines
      .filter(
        (line) =>
          line.description.trim() !== "" && (Number(line.quantity) || 0) > 0,
      )
      .map((line) => ({
        item_id: line.item_id,
        non_stock_item_id: line.non_stock_item_id,
        sku: line.sku,
        description: line.description.trim(),
        unit_of_measure: line.unit_of_measure.trim() || "pc",
        quantity: Number(line.quantity) || 0,
        unit_price: Number(line.unit_price) || 0,
      })),
  );

  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="lines" value={payload} />
      {preload ? (
        <>
          <input type="hidden" name="po_id" value={preload.poId} />
          <input type="hidden" name="receipt_id" value={preload.receiptId} />
        </>
      ) : null}

      <div>
        <label className="label" htmlFor="si-receipt">
          Against a delivery
        </label>
        <select
          id="si-receipt"
          className="select"
          value={receiptId}
          onChange={(event) => attachReceipt(event.currentTarget.value)}
        >
          <option value="">
            {receipts.length > 0
              ? "Not against a delivery — enter the items below"
              : "Nothing received is waiting to be billed"}
          </option>
          {receipts.map((row) => (
            <option key={row.receiptId} value={row.receiptId}>
              {row.receiptNo} — {row.vendorName} · {row.poNo} ·{" "}
              {money(row.value)}
            </option>
          ))}
        </select>
        <p className="text-xs muted mt-1">
          {preload
            ? `Billing ${preload.receiptNo} on ${preload.poNo}. The quantities and prices below are what arrived — change them if the supplier billed differently.`
            : "Only deliveries that have not been billed yet are listed."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="si-vendor">
            Supplier *
          </label>
          <select
            id="si-vendor"
            name="vendor_id"
            className="select"
            required
            value={vendorId}
            onChange={(event) => setVendorId(event.currentTarget.value)}
            disabled={Boolean(preload)}
          >
            <option value="">Choose…</option>
            {vendors.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
          {/* A disabled select is left out of the submission. */}
          {preload ? (
            <input type="hidden" name="vendor_id" value={preload.vendorId} />
          ) : null}
        </div>
        <div>
          <label className="label" htmlFor="si-location">
            For which property
          </label>
          <select
            id="si-location"
            name="location_id"
            className="select"
            value={locationId}
            onChange={(event) => setLocationId(event.currentTarget.value)}
          >
            <option value="">Company-wide</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.code} — {location.name}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">What the spend is charged against.</p>
        </div>

        <div>
          <label className="label" htmlFor="si-kind">
            Type
          </label>
          <select
            id="si-kind"
            name="charge_kind"
            className="select"
            value={chargeKind}
            onChange={(event) => setChargeKind(event.currentTarget.value)}
          >
            {CHARGE_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            {vendor && !vendor.is_vatable
              ? "Supplier is not VAT-registered, so nothing is withheld."
              : "Sets the creditable withholding tax, which feeds BIR 2307."}
          </p>
        </div>
        <div>
          <p className="label">Total bill</p>
          <p
            className="text-2xl font-bold tabular-nums"
            style={{ color: "var(--color-gold-500)" }}
          >
            {money(gross)}
          </p>
          <p className="text-xs muted">Adds up from the items below.</p>
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
        <div className="grid gap-4 sm:grid-cols-2">
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
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <div>
            <p className="font-semibold text-sm">Items</p>
            <p className="text-xs muted">
              Pick a stock item and its SKU, description and unit fill
              themselves in. Prices are what the supplier charged, VAT included.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setLines((current) => [...current, blankLine()])}
          >
            + Add item
          </button>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>Line</th>
                <th style={{ width: "14rem" }}>Stock item</th>
                <th style={{ width: "8rem" }}>SKU</th>
                <th>Description</th>
                <th className="text-right" style={{ width: "6rem" }}>
                  Qty
                </th>
                <th style={{ width: "5rem" }}>Unit</th>
                <th className="text-right" style={{ width: "8rem" }}>
                  Amount
                </th>
                <th className="text-right" style={{ width: "8rem" }}>
                  Total
                </th>
                <th style={{ width: "3rem" }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={line.key}>
                  <td className="text-sm tabular-nums">{index + 1}</td>
                  <td>
                    {/* Stock and services in one list: the person entering a
                        bill is picking what was bought, not classifying it. */}
                    <select
                      className="select"
                      value={
                        line.non_stock_item_id
                          ? `ns:${line.non_stock_item_id}`
                          : line.item_id
                      }
                      onChange={(event) =>
                        pickItem(line.key, event.currentTarget.value)
                      }
                      aria-label={`Item or service for line ${index + 1}`}
                    >
                      <option value="">Neither — type it below</option>
                      {items.length > 0 ? (
                        <optgroup label="Stock items">
                          {items.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      {nonStock.length > 0 ? (
                        <optgroup label="Services (non-stock)">
                          {nonStock.map((service) => (
                            <option key={service.id} value={`ns:${service.id}`}>
                              {service.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input"
                      value={line.sku}
                      onChange={(event) =>
                        updateLine(line.key, { sku: event.currentTarget.value })
                      }
                      aria-label={`SKU for line ${index + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={line.description}
                      onChange={(event) =>
                        updateLine(line.key, {
                          description: event.currentTarget.value,
                        })
                      }
                      aria-label={`Description for line ${index + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.key, {
                          quantity: event.currentTarget.value,
                        })
                      }
                      aria-label={`Quantity for line ${index + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={line.unit_of_measure}
                      onChange={(event) =>
                        updateLine(line.key, {
                          unit_of_measure: event.currentTarget.value,
                        })
                      }
                      aria-label={`Unit for line ${index + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                      value={line.unit_price}
                      onChange={(event) =>
                        updateLine(line.key, {
                          unit_price: event.currentTarget.value,
                        })
                      }
                      aria-label={`Unit price for line ${index + 1}`}
                    />
                  </td>
                  <td className="text-right tabular-nums">
                    {money(
                      round2(
                        (Number(line.quantity) || 0) *
                          (Number(line.unit_price) || 0),
                      ),
                    )}
                  </td>
                  <td className="text-right">
                    {lines.length > 1 ? (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          setLines((current) =>
                            current.filter((row) => row.key !== line.key),
                          )
                        }
                        aria-label={`Remove line ${index + 1}`}
                      >
                        ×
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
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
          </div>
          <div>
            <label className="label" htmlFor="si-notes">
              Notes
            </label>
            <input id="si-notes" name="notes" className="input" />
          </div>
        </div>

        <div className="table-scroll">
          <table className="table">
            <tbody>
              <tr>
                <td className="text-sm">VATable sales</td>
                <td className="text-right tabular-nums">{money(split.net)}</td>
              </tr>
              <tr>
                <td className="text-sm">
                  VAT{vendor && !vendor.is_vatable ? " (not registered)" : " (12%)"}
                </td>
                <td className="text-right tabular-nums">{money(split.vat)}</td>
              </tr>
              <tr>
                <td className="text-sm font-semibold">Total</td>
                <td className="text-right tabular-nums font-semibold">
                  {money(split.gross)}
                </td>
              </tr>
              {split.withholding > 0 ? (
                <>
                  <tr>
                    <td className="text-sm">Less withholding tax</td>
                    <td className="text-right tabular-nums">
                      ({money(split.withholding)})
                    </td>
                  </tr>
                  <tr>
                    <td className="text-sm font-semibold">Payable to supplier</td>
                    <td
                      className="text-right tabular-nums font-bold"
                      style={{ color: "var(--color-gold-500)" }}
                    >
                      {money(split.total)}
                    </td>
                  </tr>
                </>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
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

function RowSubmit({
  label,
  busy,
  danger,
}: {
  label: string;
  busy: string;
  danger?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={danger ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
      disabled={pending}
    >
      {pending ? busy : label}
    </button>
  );
}

function RowForm({
  action,
  voucherId,
  label,
  busy,
  danger,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  voucherId: string;
  label: string;
  busy: string;
  danger?: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={voucherId} />
      <RowSubmit label={label} busy={busy} danger={danger} />
      {state.error ? (
        <p
          className="text-xs text-right"
          style={{ color: "var(--danger)", maxWidth: "16rem" }}
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * What can be done to a voucher from the list.
 *
 * A payment goes out through the approval queue; a postdated cheque is
 * released directly, because handing over a future-dated cheque is not paying
 * anybody yet.
 */
export function VoucherRowActions({
  voucherId,
  status,
  kind,
  hasLines,
  awaitingApproval,
  canPrepare,
  canRelease,
  showAttachLink = true,
  submitAction,
  releaseAction,
  cancelAction,
}: {
  voucherId: string;
  status: string;
  kind: string;
  hasLines: boolean;
  awaitingApproval: boolean;
  canPrepare: boolean;
  canRelease: boolean;
  showAttachLink?: boolean;
  submitAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
  releaseAction: (state: ActionState, formData: FormData) => Promise<ActionState>;
  cancelAction: (formData: FormData) => Promise<void>;
}) {
  if (status === "released") {
    return <span className="text-xs muted">Posted to the ledger</span>;
  }
  if (status === "cancelled") return <span className="text-xs muted">—</span>;
  if (awaitingApproval) {
    return <span className="badge">awaiting approval</span>;
  }

  const releasesDirectly = kind === "prepayment" || kind === "void";
  const canSubmit = status === "draft" && !releasesDirectly;

  return (
    <div className="inline-flex gap-2 justify-end flex-wrap">
      {canSubmit && canPrepare ? (
        <RowForm
          action={submitAction}
          voucherId={voucherId}
          label="Send for approval"
          busy="Sending…"
        />
      ) : null}

      {(releasesDirectly || status === "approved") && canRelease && hasLines ? (
        <RowForm
          action={releaseAction}
          voucherId={voucherId}
          label="Release"
          busy="Releasing…"
        />
      ) : null}

      {!hasLines && kind === "prepayment" && canPrepare && showAttachLink ? (
        <Link
          href={`/payables/vouchers/${voucherId}`}
          className="btn btn-secondary btn-sm"
        >
          Attach invoices
        </Link>
      ) : null}

      {canPrepare ? (
        <form action={cancelAction}>
          <input type="hidden" name="id" value={voucherId} />
          <button type="submit" className="btn btn-danger btn-sm">
            Cancel
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Matches supplier invoices to a cheque already written.
 *
 * The postdated case: the cheque went out for its face value before the bills
 * arrived, and they are matched to it here before it is released.
 */
export function AttachInvoicesForm({
  action,
  voucherId,
  voucherNo,
  faceAmount,
  bills,
  attached,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  voucherId: string;
  voucherNo: string;
  faceAmount: number;
  bills: OpenBill[];
  attached: Record<string, number>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(attached).map(([id, value]) => [id, String(value)]),
    ),
  );

  const total = round2(
    Object.entries(amounts)
      .filter(([id]) => bills.some((bill) => bill.id === id))
      .reduce((sum, [, value]) => sum + (Number(value) || 0), 0),
  );
  const over = total > faceAmount;

  if (bills.length === 0) {
    return (
      <p className="text-sm muted">
        Nothing outstanding for this supplier to match against {voucherNo}.
      </p>
    );
  }

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={voucherId} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Due</th>
              <th>Job</th>
              <th className="text-right">Outstanding</th>
              <th className="text-right" style={{ width: "10rem" }}>
                Settled by this cheque
              </th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
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
                      const value = event.currentTarget.value;
                      setAmounts((current) => ({ ...current, [bill.id]: value }));
                    }}
                  />
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="text-right font-semibold">
                Matched
              </td>
              <td className="text-right text-xs muted">
                of {money(faceAmount)}
              </td>
              <td
                className="text-right tabular-nums font-semibold"
                style={over ? { color: "var(--danger)" } : undefined}
              >
                {money(total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Attach invoices" />
        <Result state={state} />
        {over ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            That is more than the cheque is written for.
          </p>
        ) : null}
      </div>
    </form>
  );
}

export type ReversibleVoucher = {
  id: string;
  voucher_no: string;
  vendor_id: string;
  amount: number;
  remaining: number;
};

export function VoucherForm({
  action,
  vendors,
  bills,
  reversible,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendors: VendorOption[];
  bills: OpenBill[];
  reversible: ReversibleVoucher[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [kind, setKind] = useState<string>("payment");
  const [method, setMethod] = useState<string>("cash");
  const [vendorId, setVendorId] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [withhold, setWithhold] = useState(false);
  const [reversesId, setReversesId] = useState("");

  const undoing = isReversal(kind);
  const vendorBills = useMemo(
    () => bills.filter((bill) => bill.vendor_id === vendorId),
    [bills, vendorId],
  );
  const vendorReversible = useMemo(
    () => reversible.filter((row) => row.vendor_id === vendorId),
    [reversible, vendorId],
  );
  const original = vendorReversible.find((row) => row.id === reversesId);
  const kindHint = VOUCHER_KINDS.find((k) => k.value === kind)?.hint;

  /** Ticking an invoice pays it in full; the figure stays editable for a part payment. */
  function toggleBill(bill: OpenBill, on: boolean) {
    setPicked((current) => ({ ...current, [bill.id]: on }));
    setAmounts((current) => ({
      ...current,
      [bill.id]: on ? String(bill.outstanding) : "",
    }));
  }

  const selected = vendorBills.filter((bill) => picked[bill.id]);
  const allPicked = vendorBills.length > 0 && selected.length === vendorBills.length;

  const paying = (bill: OpenBill) =>
    picked[bill.id] ? Number(amounts[bill.id]) || 0 : 0;

  const total = round2(
    vendorBills.reduce((sum, bill) => sum + paying(bill), 0),
  );

  // Expanded withholding is computed on the VAT-exclusive base of what is
  // being paid, and only on bills that were not already withheld from.
  const vendor = vendors.find((row) => row.id === vendorId);
  const rate = vendor?.is_vatable
    ? withholdingRate(vendor.withholding ?? "none")
    : 0;
  const withholdable = round2(
    vendorBills
      .filter((bill) => !bill.alreadyWithheld)
      .reduce((sum, bill) => sum + paying(bill) * bill.netShare, 0),
  );
  const canWithhold = rate > 0 && withholdable > 0 && !undoing;
  const withheld = canWithhold && withhold ? round2((withholdable * rate) / 100) : 0;
  const cashOut = round2(total - withheld);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="withholding_tax" value={withheld} />
      <div>
        <label className="label" htmlFor="cv-kind">
          Type of voucher *
        </label>
        <select
          id="cv-kind"
          name="voucher_kind"
          className="select"
          value={kind}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setKind(next);
            setAmounts({});
            setReversesId("");
            // A prepayment is a postdated cheque by definition.
            if (next === "prepayment") setMethod("check");
          }}
        >
          {VOUCHER_KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {kindHint ? <p className="text-xs muted mt-1">{kindHint}</p> : null}
      </div>

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
      {undoing ? (
        <div>
          <label className="label" htmlFor="cv-reverses">
            Voucher to undo *
          </label>
          <select
            id="cv-reverses"
            name="reverses_voucher_id"
            className="select"
            required
            value={reversesId}
            onChange={(event) => setReversesId(event.currentTarget.value)}
            disabled={!vendorId}
          >
            <option value="">
              {vendorId ? "Choose…" : "Pick a supplier first"}
            </option>
            {vendorReversible.map((row) => (
              <option key={row.id} value={row.id}>
                {row.voucher_no} — {money(row.remaining)} left
              </option>
            ))}
          </select>
          {vendorId && vendorReversible.length === 0 ? (
            <p className="text-xs muted mt-1">
              Nothing released for this supplier to undo.
            </p>
          ) : null}
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="cv-method">
            Paid by *
          </label>
          <select
            id="cv-method"
            name="payment_method"
            className="select"
            value={method}
            onChange={(event) => setMethod(event.currentTarget.value)}
            disabled={kind === "prepayment"}
          >
            {PAYMENT_METHODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {kind === "prepayment" ? (
            <>
              {/* A disabled select is left out of the submission, so the value
                  it is pinned to has to be carried separately. */}
              <input type="hidden" name="payment_method" value="check" />
              <p className="text-xs muted mt-1">
                A prepayment is always a cheque.
              </p>
            </>
          ) : null}
        </div>
      )}

      {undoing ? (
        <div>
          <label className="label" htmlFor="cv-amount">
            Amount returned (₱)
          </label>
          <input
            id="cv-amount"
            name="amount"
            type="number"
            step="0.01"
            min="0"
            max={original?.remaining}
            className="input"
            placeholder={original ? String(original.remaining) : "All of it"}
          />
          <p className="text-xs muted mt-1">
            {original
              ? `Up to ${money(original.remaining)}. Blank returns all of it.`
              : "Blank returns the whole voucher."}
          </p>
        </div>
      ) : null}

      {!undoing && method === "check" ? (
        <>
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
          <div>
            <label className="label" htmlFor="cv-check-date">
              Cheque date {kind === "prepayment" ? "*" : ""}
            </label>
            <input
              id="cv-check-date"
              name="check_date"
              type="date"
              className="input"
              required={kind === "prepayment"}
            />
            <p className="text-xs muted mt-1">
              {kind === "prepayment"
                ? "Must be ahead of today — that is what makes it postdated."
                : "The date written on the cheque."}
            </p>
          </div>
        </>
      ) : null}

      {kind === "prepayment" && total === 0 ? (
        <div>
          <label className="label" htmlFor="cv-face">
            Cheque face amount (₱) *
          </label>
          <input
            id="cv-face"
            name="face_amount"
            type="number"
            step="0.01"
            min="0.01"
            className="input"
            required
          />
          <p className="text-xs muted mt-1">
            Issue the cheque for its face value now and match invoices to it
            later, before you release it.
          </p>
        </div>
      ) : null}

      {vendorId && !undoing ? (
        <div className="sm:col-span-3">
          {vendorBills.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: "3rem" }}>
                      <input
                        type="checkbox"
                        checked={allPicked}
                        aria-label="Select every invoice"
                        onChange={(event) => {
                          const on = event.currentTarget.checked;
                          for (const bill of vendorBills) toggleBill(bill, on);
                        }}
                      />
                    </th>
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
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(picked[bill.id])}
                          aria-label={`Pay ${bill.invoice_no}`}
                          onChange={(event) =>
                            toggleBill(bill, event.currentTarget.checked)
                          }
                        />
                      </td>
                      <td className="text-sm">{bill.invoice_no}</td>
                      <td className="text-xs">{formatDate(bill.due_date)}</td>
                      <td className="text-xs">{bill.jobNo ?? "—"}</td>
                      <td className="text-right tabular-nums">
                        {money(bill.outstanding)}
                      </td>
                      <td className="text-right">
                        {/* Only a ticked invoice is submitted, so an amount
                            left behind from an earlier tick cannot be paid. */}
                        <input
                          name={picked[bill.id] ? `pay:${bill.id}` : undefined}
                          type="number"
                          step="0.01"
                          min="0"
                          max={bill.outstanding}
                          className="input tabular-nums"
                          style={{ textAlign: "right" }}
                          disabled={!picked[bill.id]}
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
                    <td colSpan={4} className="text-right font-semibold">
                      {selected.length > 0
                        ? `Paying ${selected.length} invoice(s)`
                        : "Tick the invoices to pay"}
                    </td>
                    <td />
                    <td className="text-right tabular-nums font-semibold">
                      {money(total)}
                    </td>
                  </tr>
                  {withheld > 0 ? (
                    <>
                      <tr>
                        <td colSpan={4} className="text-right">
                          Less withholding tax at {rate}%
                        </td>
                        <td />
                        <td className="text-right tabular-nums">
                          ({money(withheld)})
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={4} className="text-right font-bold">
                          Cash to the supplier
                        </td>
                        <td />
                        <td
                          className="text-right tabular-nums font-bold"
                          style={{ color: "var(--color-gold-500)" }}
                        >
                          {money(cashOut)}
                        </td>
                      </tr>
                    </>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm muted">Nothing outstanding for this supplier.</p>
          )}

          {canWithhold ? (
            <label
              className="flex items-start gap-2 mt-3"
              style={{ cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={withhold}
                onChange={(event) => setWithhold(event.currentTarget.checked)}
                style={{ marginTop: "0.2rem" }}
              />
              <span>
                <span className="text-sm font-medium">
                  Withhold {rate}% tax on payment
                </span>
                <span className="block text-xs muted">
                  {money(round2((withholdable * rate) / 100))} held back from{" "}
                  {money(withholdable)} of VAT-exclusive value. The supplier&rsquo;s
                  balance is still settled in full — they get the cash and a BIR
                  Form 2307 for the rest.
                </span>
              </span>
            </label>
          ) : vendor?.is_vatable && rate === 0 && vendorBills.length > 0 ? (
            <p className="text-xs muted mt-3">
              No withholding is set on this supplier, so nothing is deducted.
            </p>
          ) : null}
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
