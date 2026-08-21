"use client";

import { useEffect, useState } from "react";

/**
 * When a document was printed, in the bottom right of the page.
 *
 * Stamped at the moment the print dialog opens rather than when the page was
 * rendered. A report left open across the afternoon and printed at five would
 * otherwise carry the time it was first loaded, which is exactly the sort of
 * quiet wrongness a printed record must not have.
 *
 * Rendered once in the app layout so every printable document carries it --
 * invoices, vouchers, contracts, cheque acknowledgements, purchase orders,
 * every report -- without each having to remember to.
 *
 * Fixed rather than placed in the flow so it sits at the foot of the sheet and
 * repeats on each page of a long report, and hidden on screen, where it would
 * be noise.
 */
export function PrintStamp() {
  const [stamp, setStamp] = useState("");

  useEffect(() => {
    const mark = () =>
      setStamp(
        new Date().toLocaleString("en-PH", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      );

    // Chrome and Safari fire beforeprint; the media query catches the rest,
    // including a print triggered from the browser's own menu.
    window.addEventListener("beforeprint", mark);
    const media = window.matchMedia("print");
    const onMedia = (event: MediaQueryListEvent) => {
      if (event.matches) mark();
    };
    media.addEventListener("change", onMedia);

    return () => {
      window.removeEventListener("beforeprint", mark);
      media.removeEventListener("change", onMedia);
    };
  }, []);

  return (
    <div className="print-stamp print-only" aria-hidden="true">
      Printed {stamp}
    </div>
  );
}
