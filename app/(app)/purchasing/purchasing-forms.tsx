"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import { money } from "@/lib/format";

import type { ActionState } from "./actions";
import { WITHHOLDING_KINDS } from "./constants";

export type VendorOption = { id: string; name: string };
export type ItemOption = { id: string; name: string; unit_of_measure: string };
export type RequestOption = {
  id: string;
  request_no: string;
  locationLabel: string;
};
export type LocationOption = { id: string; code: string; name: string };
export type ExpenseAccountOption = { id: string; code: string; name: string };

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
      <div className="sm:col-span-3">
        <label className="label" htmlFor="vendor-address">
          Address
        </label>
        <input id="vendor-address" name="address" className="input" />
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
  function update(index: number, patch: Partial<Line>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  const total = lines.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.price) || 0),
    0,
  );

  return (
    <>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
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
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    name="line_item"
                    className="select"
                    value={line.itemId}
                    onChange={(event) => {
                      const itemId = event.currentTarget.value;
                      const item = items.find((candidate) => candidate.id === itemId);
                      update(index, {
                        itemId,
                        description: item ? item.name : line.description,
                        // A stocked line is charged to Inventory, so any
                        // expense account chosen earlier no longer applies.
                        expenseAccountId: itemId ? "" : line.expenseAccountId,
                      });
                    }}
                  >
                    <option value="">Service / non-stock</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
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
              </tr>
            ))}
            <tr>
              <td colSpan={5} className="text-right font-semibold">
                Estimated total
              </td>
              <td className="text-right tabular-nums font-semibold">{money(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="btn btn-secondary btn-sm mt-2"
        onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
      >
        Add line
      </button>
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

export function PurchaseRequestForm({
  action,
  items,
  expenseAccounts,
  locations,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  items: ItemOption[];
  expenseAccounts: ExpenseAccountOption[];
  locations: LocationOption[];
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

  return (
    <form action={formAction} className="flex flex-col gap-4">
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
            onChange={(event) => setRequestId(event.currentTarget.value)}
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

      <div className="flex items-center gap-3 flex-wrap">
        <Submit label="Create order" />
        <Result state={state} />
      </div>
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
