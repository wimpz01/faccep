/**
 * How a billing is laid out when printed.
 *
 * The values live in invoice_print_settings, one row per company. This module
 * only says what they mean and what to fall back on when a company has no row
 * -- which should not happen, since one is seeded on creation, but a printout
 * that fails because a settings row is missing is a worse answer than one that
 * prints at sensible defaults.
 */

export type InvoicePrintSettings = {
  page_width_in: number;
  page_height_in: number;
  margin_in: number;
  body_font_pt: number;
  table_font_pt: number;
  show_logo: boolean;
  show_company_header: boolean;
  show_meter_dates: boolean;
  show_meter_columns: boolean;
  show_vat_column: boolean;
  show_payment_note: boolean;
  show_signatures: boolean;
  footer_note: string | null;
};

/** Half letter on its side, which is the common Philippine billing sheet. */
export const DEFAULT_PRINT_SETTINGS: InvoicePrintSettings = {
  page_width_in: 8.5,
  page_height_in: 5.5,
  margin_in: 0.35,
  body_font_pt: 8.5,
  table_font_pt: 8,
  show_logo: true,
  show_company_header: true,
  show_meter_dates: false,
  show_meter_columns: true,
  show_vat_column: true,
  show_payment_note: true,
  show_signatures: true,
  footer_note: null,
};

/** The sheets people actually ask for, by name. */
export const PAGE_PRESETS = [
  { label: "Half letter — landscape", width: 8.5, height: 5.5 },
  { label: "Half letter — portrait", width: 5.5, height: 8.5 },
  { label: "Letter — portrait", width: 8.5, height: 11 },
  { label: "Letter — landscape", width: 11, height: 8.5 },
  { label: "A4 — portrait", width: 8.27, height: 11.69 },
  { label: "A4 — landscape", width: 11.69, height: 8.27 },
] as const;

/** Numbers arrive from PostgREST as strings on some columns and not others. */
export function readPrintSettings(
  row: Record<string, unknown> | null | undefined,
): InvoicePrintSettings {
  if (!row) return DEFAULT_PRINT_SETTINGS;

  const num = (key: keyof InvoicePrintSettings, fallback: number) => {
    const value = Number(row[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const flag = (key: keyof InvoicePrintSettings, fallback: boolean) =>
    typeof row[key] === "boolean" ? (row[key] as boolean) : fallback;

  return {
    page_width_in: num("page_width_in", DEFAULT_PRINT_SETTINGS.page_width_in),
    page_height_in: num("page_height_in", DEFAULT_PRINT_SETTINGS.page_height_in),
    margin_in: num("margin_in", DEFAULT_PRINT_SETTINGS.margin_in),
    body_font_pt: num("body_font_pt", DEFAULT_PRINT_SETTINGS.body_font_pt),
    table_font_pt: num("table_font_pt", DEFAULT_PRINT_SETTINGS.table_font_pt),
    show_logo: flag("show_logo", true),
    show_company_header: flag("show_company_header", true),
    show_meter_dates: flag("show_meter_dates", false),
    show_meter_columns: flag("show_meter_columns", true),
    show_vat_column: flag("show_vat_column", true),
    show_payment_note: flag("show_payment_note", true),
    show_signatures: flag("show_signatures", true),
    footer_note:
      typeof row.footer_note === "string" && row.footer_note.trim() !== ""
        ? (row.footer_note as string)
        : null,
  };
}

/**
 * The print stylesheet for one company's chosen sheet.
 *
 * Emitted into the document itself rather than the global stylesheet, so it
 * applies to the billing and leaves every other document on A4.
 */
export function printStyleFor(settings: InvoicePrintSettings) {
  return `
    @media print {
      @page {
        size: ${settings.page_width_in}in ${settings.page_height_in}in;
        margin: ${settings.margin_in}in;
      }
      .doc-sheet {
        font-size: ${settings.body_font_pt}pt;
        line-height: 1.35;
      }
      .doc-sheet table {
        font-size: ${settings.table_font_pt}pt;
      }
    }
  `;
}
