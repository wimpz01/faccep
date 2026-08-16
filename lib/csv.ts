/**
 * Reading the CSV a spreadsheet actually writes.
 *
 * Shared by the importers rather than copied into each: the quoting rules are
 * fiddly enough that two versions would eventually disagree about one of them.
 */

/**
 * Splits one CSV line, honouring quoted fields.
 *
 * Excel quotes any field containing a comma, so "Cruz, Maria" has to survive as
 * a single value rather than becoming two columns.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }
  out.push(field.trim());
  return out;
}

/**
 * A file's non-empty lines, with the byte-order mark stripped.
 *
 * Excel writes a BOM on UTF-8 CSV, and left in place it becomes part of the
 * first column's name -- so the header check fails on a file that looks
 * perfectly correct on screen.
 */
export function csvLines(raw: string): string[] {
  return raw
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Quotes a field only when it needs it, the way Excel writes CSV. */
export function csvCell(value: string | number | boolean | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
