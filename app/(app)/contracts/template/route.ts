import { NextResponse } from "next/server";

import { csvCell } from "@/lib/csv";

/**
 * A starting spreadsheet for importing contracts.
 *
 * unit_codes takes one code or several separated by a semicolon, for a lease
 * over more than one unit. Where two properties use the same unit code, write
 * it as PROPERTY/UNIT.
 */
export function GET() {
  const columns = [
    "tenant",
    "unit_codes",
    "contract_no",
    "status",
    "start_date",
    "end_date",
    "monthly_rent",
    "security_deposit",
    "advance_payment",
    "rent_due_day",
    "notes",
  ];
  const example = [
    "Sunrise Hardware Trading",
    "BLDG-A/201",
    "",
    "active",
    "2026-01-01",
    "2026-12-31",
    "25000",
    "50000",
    "25000",
    "5",
    "Renewed for a second year",
  ];

  const body = [
    columns.join(","),
    example.map((cell) => csvCell(cell)).join(","),
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="contracts-template.csv"',
    },
  });
}
