"use client";

/**
 * Opens the browser print dialog, where "Save as PDF" is a destination.
 * Every generated document uses this so Print and PDF stay one code path.
 */
export function PrintButton({ label = "Print / Save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
