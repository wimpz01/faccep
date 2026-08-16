import { NextResponse } from "next/server";

import { getSessionContext } from "@/lib/auth";
import { csvCell } from "@/lib/csv";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

type Row = {
  company_name: string;
  address: string | null;
  company_number: string | null;
  contact_person: string | null;
  mobile_number: string | null;
  email: string | null;
  tin: string | null;
  is_vatable: boolean;
  notes: string | null;
  status: string;
};

/**
 * The tenant list as CSV.
 *
 * The columns the importer reads come first and in its order, so an exported
 * file can be edited and fed straight back in. Status follows as read-only
 * context: it is moved by signing and ending contracts, not by a spreadsheet.
 *
 * ?template=1 gives the header with one filled row, for starting from scratch.
 */
export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context?.activeCompany) {
    return new NextResponse("Not signed in.", { status: 401 });
  }
  if (!can(context.permissions, MODULE.tenants, "view")) {
    return new NextResponse("Not allowed.", { status: 403 });
  }

  const header = [
    "company_name",
    "tin",
    "is_vatable",
    "address",
    "contact_person",
    "mobile_number",
    "email",
    "company_number",
    "notes",
    "status",
  ];

  const templateOnly = new URL(request.url).searchParams.get("template") === "1";
  const lines = [header.join(",")];

  if (templateOnly) {
    // Two rows: one VAT-registered, one not, so the yes/no column is obvious.
    lines.push(
      [
        "Sunrise Hardware Trading",
        "004-231-889-000",
        "yes",
        "Ground floor, BLDG-A",
        "Melchor Ramos",
        "0917 000 0000",
        "melchor@example.com",
        "SEC-12345",
        "Anchor tenant",
        "",
      ]
        .map(csvCell)
        .join(","),
    );
    lines.push(
      ["Kapetirya Cafe", "", "no", "Corner unit, BLDG-A", "Joselito Bautista", "", "", "", "", ""]
        .map(csvCell)
        .join(","),
    );
  } else {
    const supabase = await createClient();
    const { data } = await supabase
      .from("tenants")
      .select(
        "company_name, address, company_number, contact_person, mobile_number, email, tin, is_vatable, notes, status",
      )
      .eq("company_id", context.activeCompany.companyId)
      .order("company_name")
      .returns<Row[]>();

    for (const tenant of data ?? []) {
      lines.push(
        [
          csvCell(tenant.company_name),
          csvCell(tenant.tin),
          csvCell(tenant.is_vatable ? "yes" : "no"),
          csvCell(tenant.address),
          csvCell(tenant.contact_person),
          csvCell(tenant.mobile_number),
          csvCell(tenant.email),
          csvCell(tenant.company_number),
          csvCell(tenant.notes),
          csvCell(tenant.status),
        ].join(","),
      );
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = templateOnly
    ? "tenant-import-template.csv"
    : `tenants-${stamp}.csv`;

  // The BOM makes Excel read it as UTF-8, so accented names and the peso sign
  // do not arrive mangled.
  return new NextResponse(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
