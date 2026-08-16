"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { ItemPicker } from "@/components/item-picker";
import { FormError } from "@/components/ui";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";
import { WITHHOLDING_KINDS } from "./constants";

export type VendorOption = { id: string; name: string };
export type ItemOption = {
  id: string;
  name: string;
  unit_of_measure: string;
  /** Shown while picking, because what to order depends on what is left. */
  onHand?: number;
  sku?: string | null;
};
export type RequestOption = {
  id: string;
  request_no: string;
  locationLabel: string;
  /** What was approved, so the order does not have to be keyed in again. */
  lines: {
    itemId: string;
    description: string;
    quantity: string;
    price: string;
  }[];
};
export type LocationOption = { id: string; code: string; name: string };
export type ExpenseAccountOption = { id: string; code: string; name: string };

/** Sized to sit in a card header alongside the title. */
function SubmitSmall({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Working…" : label}
    </button>
  );
}

function ResendSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Sending…" : "Send for approval"}
    </button>
  );
}

/** Recovers a pending supplier whose approval request has gone missing. */
export function ResendApprovalForm({
  action,
  vendorId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendorId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={vendorId} />
      <ResendSubmit />
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
 * What Form 2307 needs about a supplier, filled in after the fact.
 *
 * Only the boxes the certificate prints. The supplier's terms and VAT status
 * were signed off at approval and are not editable here.
 */
export function VendorTaxDetailsForm({
  action,
  vendor,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendor: {
    id: string;
    tin: string | null;
    address: string | null;
    zip_code: string | null;
    atc_code: string | null;
  };
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        Tax details
      </button>
    );
  }

  return (
    <form action={formAction} className="grid gap-2 text-left">
      <input type="hidden" name="id" value={vendor.id} />
      <input
        name="tin"
        className="input"
        placeholder="TIN 000-000-000-000"
        defaultValue={vendor.tin ?? ""}
      />
      <input
        name="address"
        className="input"
        placeholder="Registered address"
        defaultValue={vendor.address ?? ""}
      />
      <div className="flex gap-2">
        <input
          name="zip_code"
          className="input"
          placeholder="ZIP"
          defaultValue={vendor.zip_code ?? ""}
        />
        <input
          name="atc_code"
          className="input"
          placeholder="ATC e.g. WC640"
          defaultValue={vendor.atc_code ?? ""}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SubmitSmall label="Save" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
      <Result state={state} />
    </form>
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

export type PaymentTermOption = { id: string; name: string; days: number };

export function VendorForm({
  action,
  terms,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  terms: PaymentTermOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [isVatable, setIsVatable] = useState(false);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="vendor-name">
          Supplier name *
        </label>
        <input id="vendor-name" name="name" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="vendor-tin">
          TIN
        </label>
        <input id="vendor-tin" name="tin" className="input" placeholder="000-000-000-000" />
      </div>
      <div>
        <label className="label" htmlFor="vendor-terms">
          Payment terms
        </label>
        <select
          id="vendor-terms"
          name="payment_terms_id"
          className="select"
          defaultValue=""
        >
          <option value="">Not agreed</option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              {/* Most names already say the number; only spell it out when not. */}
              {term.days > 0 && !term.name.includes(String(term.days))
                ? `${term.name} — ${term.days} days`
                : term.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="vendor-contact">
          Contact person
        </label>
        <input id="vendor-contact" name="contact_person" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="vendor-number">
          Contact number
        </label>
        <input id="vendor-number" name="contact_number" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="vendor-email">
          Email
        </label>
        <input id="vendor-email" name="email" type="email" className="input" />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="vendor-address">
          Registered address
        </label>
        <input id="vendor-address" name="address" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="vendor-zip">
          ZIP code
        </label>
        <input id="vendor-zip" name="zip_code" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="vendor-atc">
          ATC code
        </label>
        <input
          id="vendor-atc"
          name="atc_code"
          className="input"
          placeholder="WC640"
        />
        <p className="text-xs muted mt-1">
          Printed on BIR Form 2307. WC640 for goods, WC158 for services.
        </p>
      </div>

      <div>
        <p className="label">VAT</p>
        <label
          className="flex items-start gap-2 text-sm"
          style={{ cursor: "pointer", paddingTop: "0.5rem" }}
        >
          <input
            type="checkbox"
            name="is_vatable"
            className="h-4 w-4 accent-[var(--color-brand-600)]"
            style={{ marginTop: "0.15rem" }}
            checked={isVatable}
            onChange={(event) => setIsVatable(event.currentTarget.checked)}
          />
          <span>VAT-registered</span>
        </label>
      </div>

      <div className="sm:col-span-2">
        <label className="label" htmlFor="vendor-withholding">
          Withholding tax
        </label>
        {isVatable ? (
          <>
            <select
              id="vendor-withholding"
              name="withholding"
              className="select"
              defaultValue="none"
            >
              {WITHHOLDING_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
            <p className="text-xs muted mt-1">
              Deducted from what you pay them and remitted to the BIR.
            </p>
          </>
        ) : (
          <p className="text-sm muted pt-2">
            Only applies to a VAT-registered supplier.
          </p>
        )}
      </div>

      <div className="sm:col-span-3 flex items-center gap-3 flex-wrap">
        <Submit label="Add supplier" />
        <Result state={state} />
      </div>
    </form>
  );
}

type Line = {
  description: string;
  quantity: string;
  price: string;
  itemId: string;
  expenseAccountId: string;
};

/**
 * Shared line editor for purchase requests and purchase orders.
 *
 * A line is either stocked — pick an inventory item, and it lands in Inventory
 * — or not, in which case it needs the expense account it belongs to. Services
 * and utilities are the common non-stock cases.
 */
function LineEditor({
  lines,
  setLines,
  items,
  expenseAccounts,
  showPrice,
}: {
  lines: Line[];
  setLines: (next: Line[]) => void;
  items: ItemOption[];
  expenseAccounts: ExpenseAccountOption[];
  showPrice: boolean;
}) {
  const [picking, setPicking] = useState(false);

  function update(index: number, patch: Partial<Line>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  /**
   * Adds a picked item, or bumps the one already on the request.
   *
   * Two rows for the same item is a mistake waiting to be ordered twice, so
   * picking it again means "one more of these" rather than a duplicate.
   */
  function addItem(item: ItemOption) {
    const existing = lines.findIndex((line) => line.itemId === item.id);
    if (existing >= 0) {
      const current = Number(lines[existing].quantity) || 0;
      update(existing, { quantity: String(current + 1) });
      return;
    }

    // An untouched blank row is filled rather than left above the new line.
    const blank = lines.findIndex(
      (line) => !line.itemId && !line.description && !line.quantity && !line.price,
    );
    const filled: Line = {
      ...EMPTY_LINE,
      itemId: item.id,
      description: item.name,
      quantity: "1",
    };
    if (blank >= 0) {
      setLines(lines.map((line, i) => (i === blank ? filled : line)));
      return;
    }
    setLines([...lines, filled]);
  }

  const total = lines.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.price) || 0),
    0,
  );

  return (
    <>
      {picking ? (
        <ItemPicker
          items={items}
          onAdd={addItem}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {/* Above the lines, because this is how a line gets there. */}
      <div className="flex gap-2 flex-wrap mb-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setPicking(true)}
          disabled={items.length === 0}
        >
          + Add items
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
        >
          Add a service line
        </button>
      </div>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "2.5rem" }} className="text-right">#</th>
              <th style={{ minWidth: "11rem" }}>Stock item</th>
              <th style={{ minWidth: "12rem" }}>Charge to</th>
              <th>Description</th>
              <th className="text-right" style={{ width: "7rem" }}>
                Qty
              </th>
              {showPrice ? (
                <th className="text-right" style={{ width: "8rem" }}>
                  Unit price
                </th>
              ) : (
                <th className="text-right" style={{ width: "8rem" }}>
                  Est. price
                </th>
              )}
              <th className="text-right">Amount</th>
              <th style={{ width: "3rem" }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="text-right tabular-nums text-xs muted">
                  {index + 1}
                </td>
                {/* The item is chosen in the picker, not here, so the row
                    states what it is rather than offering the whole catalogue
                    on every line. The hidden field keeps what is submitted
                    exactly as it was. */}
                <td>
                  <input type="hidden" name="line_item" value={line.itemId} />
                  {line.itemId ? (
                    <span className="text-sm font-semibold">
                      {items.find((item) => item.id === line.itemId)?.name ??
                        line.description}
                    </span>
                  ) : (
                    <span className="text-xs muted">Service / non-stock</span>
                  )}
                </td>
                <td>
                  {line.itemId ? (
                    <>
                      <input type="hidden" name="line_expense" value="" />
                      <span className="text-xs muted">Inventory</span>
                    </>
                  ) : (
                    <select
                      name="line_expense"
                      className="select"
                      value={line.expenseAccountId}
                      onChange={(event) =>
                        update(index, { expenseAccountId: event.currentTarget.value })
                      }
                    >
                      <option value="">Default expense account</option>
                      {expenseAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} — {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <input
                    name="line_desc"
                    className="input"
                    value={line.description}
                    onChange={(event) =>
                      update(index, { description: event.currentTarget.value })
                    }
                  />
                </td>
                <td>
                  <input
                    name="line_qty"
                    type="number"
                    step="0.001"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    value={line.quantity}
                    onChange={(event) =>
                      update(index, { quantity: event.currentTarget.value })
                    }
                  />
                </td>
                <td>
                  <input
                    name="line_price"
                    type="number"
                    step="0.0001"
                    min="0"
                    className="input tabular-nums"
                    style={{ textAlign: "right" }}
                    value={line.price}
                    onChange={(event) =>
                      update(index, { price: event.currentTarget.value })
                    }
                  />
                </td>
                <td className="text-right tabular-nums">
                  {money(
                    (Number(line.quantity) || 0) * (Number(line.price) || 0),
                  )}
                </td>
                <td className="text-right">
                  {/* The last line stays: a document with no lines is not a
                      document, and "Add line" would be the only way back. */}
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      aria-label={`Remove line ${index + 1}`}
                      title="Remove this line"
                      onClick={() =>
                        setLines(lines.filter((_, i) => i !== index))
                      }
                    >
                      ×
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={6} className="text-right font-semibold">
                Estimated total
              </td>
              <td className="text-right tabular-nums font-semibold">{money(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

    </>
  );
}

const EMPTY_LINE: Line = {
  description: "",
  quantity: "",
  price: "",
  itemId: "",
  expenseAccountId: "",
};

/** An open repair job this spend can be traced back to. */
export type JobOption = {
  id: string;
  job_no: string;
  label: string;
  location_id: string | null;
};

export function PurchaseRequestForm({
  action,
  items,
  expenseAccounts,
  locations,
  jobs = [],
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  items: ItemOption[];
  expenseAccounts: ExpenseAccountOption[];
  locations: LocationOption[];
  jobs?: JobOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [lines, setLines] = useState<Line[]>([
    { ...EMPTY_LINE },
    { ...EMPTY_LINE },
  ]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="pr-location">
            For which property
          </label>
          <select
            id="pr-location"
            name="location_id"
            className="select"
            defaultValue=""
          >
            <option value="">Company-wide</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.code} — {location.name}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            What the spend is charged against.
          </p>
        </div>
        {/* Optional on purpose: plenty of buying answers to no repair job.
            Where one does, naming it is what lets an auditor follow the spend
            from the job that caused it to the order that met it. */}
        <div>
          <label className="label" htmlFor="pr-job">
            Repair job
          </label>
          <select
            id="pr-job"
            name="job_id"
            className="select"
            defaultValue=""
            disabled={jobs.length === 0}
          >
            <option value="">
              {jobs.length === 0 ? "No open repair jobs" : "Not for a repair job"}
            </option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.job_no} — {job.label}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            Optional. Links the spend to the job that caused it.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="pr-needed">
            Needed by
          </label>
          <input id="pr-needed" name="needed_by" type="date" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="pr-justification">
            Why it is needed
          </label>
          <input
            id="pr-justification"
            name="justification"
            className="input"
            placeholder="Replacing corroded pipework in Block A"
          />
        </div>
      </div>

      <LineEditor
        lines={lines}
        setLines={setLines}
        items={items}
        expenseAccounts={expenseAccounts}
        showPrice={false}
      />

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Raise request" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function PurchaseOrderForm({
  action,
  vendors,
  items,
  expenseAccounts,
  approvedRequests,
  locations,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  vendors: VendorOption[];
  items: ItemOption[];
  expenseAccounts: ExpenseAccountOption[];
  approvedRequests: RequestOption[];
  locations: LocationOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [requestId, setRequestId] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { ...EMPTY_LINE },
    { ...EMPTY_LINE },
  ]);

  const fromRequest = approvedRequests.find((row) => row.id === requestId);

  // The card is rendered here rather than around this form, so the buttons in
  // its header are inside the form and can submit it.
  return (
    <form action={formAction}>
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="font-semibold text-sm">Create an order</h2>
            <p className="text-xs muted mt-0.5">
              An order raised against a request is refused unless that request
              is approved.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link href="/purchasing/orders" className="btn btn-secondary btn-sm">
              Cancel
            </Link>
            <SubmitSmall label="Create order" />
          </div>
        </div>

        <div className="card-body flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="po-vendor">
            Supplier *
          </label>
          <select id="po-vendor" name="vendor_id" className="select" required defaultValue="">
            <option value="">Choose…</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="po-request">
            Against request
          </label>
          <select
            id="po-request"
            name="request_id"
            className="select"
            value={requestId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setRequestId(next);
              // The approved request is what the order is for, so its lines
              // become the order's. Clearing it starts from blank again.
              const picked = approvedRequests.find((row) => row.id === next);
              setLines(
                picked && picked.lines.length > 0
                  ? picked.lines.map((line) => ({
                      ...EMPTY_LINE,
                      itemId: line.itemId,
                      description: line.description,
                      quantity: line.quantity,
                      price: line.price,
                    }))
                  : [{ ...EMPTY_LINE }, { ...EMPTY_LINE }],
              );
            }}
          >
            <option value="">None — direct order</option>
            {approvedRequests.map((request) => (
              <option key={request.id} value={request.id}>
                {request.request_no} · {request.locationLabel}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">Only approved requests appear here.</p>
        </div>
        <div>
          <label className="label" htmlFor="po-expected">
            Expected delivery
          </label>
          <input id="po-expected" name="expected_date" type="date" className="input" />
        </div>

        <div>
          <p className="label">For which property</p>
          {fromRequest ? (
            <p className="text-sm pt-2">
              {fromRequest.locationLabel}
              <span className="block text-xs muted">
                Taken from {fromRequest.request_no}.
              </span>
            </p>
          ) : (
            <>
              <select
                id="po-location"
                name="location_id"
                className="select"
                defaultValue=""
              >
                <option value="">Company-wide</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} — {location.name}
                  </option>
                ))}
              </select>
              <p className="text-xs muted mt-1">
                What the spend is charged against.
              </p>
            </>
          )}
        </div>
      </div>

      <LineEditor
        lines={lines}
        setLines={setLines}
        items={items}
        expenseAccounts={expenseAccounts}
        showPrice
      />

      <div>
        <label className="label" htmlFor="po-notes">
          Notes
        </label>
        <input id="po-notes" name="notes" className="input" />
      </div>

          <Result state={state} />
        </div>
      </section>
    </form>
  );
}

export function SubmitRequestForm({
  action,
  requestId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  requestId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={requestId} />
      <button type="submit" className="btn btn-secondary btn-sm">
        Submit for approval
      </button>
      <Result state={state} />
    </form>
  );
}

export function ReceiveForm({
  action,
  poId,
  lines,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  poId: string;
  lines: {
    id: string;
    description: string;
    ordered: number;
    received: number;
  }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction}>
      <input type="hidden" name="po_id" value={poId} />
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Ordered</th>
              <th className="text-right">Already in</th>
              <th className="text-right">Outstanding</th>
              <th className="text-right" style={{ width: "9rem" }}>
                Receiving now
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const outstanding = line.ordered - line.received;
              return (
                <tr key={line.id}>
                  <td className="text-sm">{line.description}</td>
                  <td className="text-right tabular-nums">{line.ordered}</td>
                  <td className="text-right tabular-nums">{line.received}</td>
                  <td className="text-right tabular-nums">{outstanding}</td>
                  <td className="text-right">
                    <input
                      name={`receive:${line.id}`}
                      type="number"
                      step="0.001"
                      min="0"
                      max={outstanding}
                      disabled={outstanding <= 0}
                      className="input tabular-nums"
                      style={{ textAlign: "right" }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <input name="notes" className="input" placeholder="Delivery note reference" style={{ maxWidth: "16rem" }} />
        <Submit label="Record receipt" />
        <Result state={state} />
      </div>
    </form>
  );
}

/**
 * Ends a purchase order. A reason is required because a cancelled order stays
 * on file — the record has to say why nothing was bought on it.
 */
export function CancelOrderForm({
  action,
  poId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  poId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => setOpen(true)}
      >
        Cancel order
      </button>
    );
  }

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={poId} />
      <div>
        <label className="label" htmlFor="po-cancel-reason">
          Why is it being cancelled? *
        </label>
        <input
          id="po-cancel-reason"
          name="reason"
          className="input"
          required
          placeholder="Supplier cannot deliver; ordering elsewhere"
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <CancelSubmit />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOpen(false)}
        >
          Keep the order
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}

function CancelSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger" disabled={pending}>
      {pending ? "Cancelling…" : "Cancel this order"}
    </button>
  );
}

/** Takes back an issue so the order becomes a draft again. */
export function UnissueOrderForm({
  action,
  poId,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  poId: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className="flex items-center gap-3 flex-wrap">
      <input type="hidden" name="id" value={poId} />
      <UnissueSubmit />
      <Result state={state} />
    </form>
  );
}

function UnissueSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-secondary" disabled={pending}>
      {pending ? "Taking back…" : "Take back the issue"}
    </button>
  );
}
