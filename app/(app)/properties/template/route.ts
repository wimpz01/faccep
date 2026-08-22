import { NextResponse } from "next/server";

import { csvCell } from "@/lib/csv";

/**
 * A starting spreadsheet for importing units.
 *
 * location_code is the property's own code, which has to exist already --
 * units hang off a property, so the properties go in first.
 */
export function GET() {
  const columns = [
    "location_code",
    "code",
    "floor",
    "area_sqm",
    "monthly_rate",
    "description",
    "water_meter_serial",
    "electric_meter_serial",
  ];
  const example = [
    "BLDG-A",
    "201",
    "Second",
    "48",
    "25000",
    "Corner unit facing the road",
    "W-00123",
    "E-00456",
  ];

  const body = [
    columns.join(","),
    example.map((cell) => csvCell(cell)).join(","),
  ].join("\n");

  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="units-template.csv"',
    },
  });
}
