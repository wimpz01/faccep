import { NextResponse } from "next/server";

import { csvCell } from "@/lib/csv";

/**
 * A starting spreadsheet for importing locations.
 *
 * Header plus one filled row, so the shape is obvious without reading the
 * column reference beside it. The invoice letter is not a column: the database
 * assigns one per property, and letting a file choose would collide two
 * properties on the same series.
 */
export function GET() {
  const columns = ["code", "name", "property_type", "address", "is_active"];
  const example = [
    "BLDG-C",
    "Riverside Arcade",
    "commercial_building",
    "12 Riverside Road, Iloilo City",
    "yes",
  ];

  const body = [
    columns.join(","),
    example.map((cell) => csvCell(cell)).join(","),
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="locations-template.csv"',
    },
  });
}
