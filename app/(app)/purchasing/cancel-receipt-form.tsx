"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-danger btn-sm" disabled={pending}>
      {pending ? "Cancelling…" : "Cancel receipt"}
    </button>
  );
}

/**
 * Takes a receipt back, on the record.
 *
 * A reason is asked for and kept, because a delivery that was recorded and
 * then unrecorded is exactly the kind of thing somebody has to explain later.
 * The button opens the reason rather than acting on the first click: this
 * pulls stock back out and reopens the order, which is not a thing to do by
 * brushing past a control.
 */
export function CancelReceiptForm({
  action,
  receiptId,
  receiptNo,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  receiptId: string;
  receiptNo: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (state.success) {
    return (
      <span className="text-xs" style={{ color: "var(--success)" }}>
        Cancelled
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen(true)}
      >
        Cancel receipt
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2 items-end">
      <input type="hidden" name="receipt_id" value={receiptId} />
      <input
        name="reason"
        className="input"
        required
        autoFocus
        placeholder="Keyed against the wrong order"
        aria-label={`Why ${receiptNo} is being cancelled`}
        style={{ minWidth: "16rem" }}
      />
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <Submit />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(false)}
        >
          Keep it
        </button>
      </div>
      <FormError message={state.error} />
    </form>
  );
}
