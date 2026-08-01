"use client";

/** Printing is a browser action, so the button has to live on the client. */
export function DepositSlipActions() {
  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={() => window.print()}
    >
      Print slip
    </button>
  );
}
