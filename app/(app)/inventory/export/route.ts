import { NextResponse } from "next/server";

import { getSessionContext } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

type Row = {
  sku: string;
  name: string;
  unit_of_measure: string;
  reorder_level: string;
  unit_cost: string;
  quantity_on_hand: string;
  is_active: boolean;
  inventory_categories: { name: string } | null;
};

/** Quotes a field only when it needs it, the way Excel writes CSV. */
function cell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The stock list as CSV.
 *
 * The columns the importer reads come first, so the same file can be edited and
 * fed straight back in; sku and on-hand follow as read-only context. Passing
 * ?template=1 gives the header alone, for starting from scratch.
 */
export async function GET(request: Request) {
  const context = await getSessionContext();
  if (!context?.activeCompany) {
    return new NextResponse("Not signed in.", { status: 401 });
  }
  if (!can(context.permissions, MODULE.inventoryItems, "view")) {
    return new NextResponse("Not allowed.", { status: 403 });
  }

  const header = [
    "name",
    "category",
    "unit_of_measure",
    "reorder_level",
    "unit_cost",
    "sku",
    "quantity_on_hand",
  ];

  const templateOnly = new URL(request.url).searchParams.get("template") === "1";
  const lines = [header.join(",")];

  if (templateOnly) {
    // One filled row so the expected shape is obvious.
    lines.push(["Portland cement 40kg", "Construction", "bag", "20", "285", "", ""].join(","));
  } else {
    const supabase = await createClient();
    const { data } = await supabase
      .from("inventory_items")
      .select(
        "sku, name, unit_of_measure, reorder_level, unit_cost, quantity_on_hand, is_active, inventory_categories(name)",
      )
      .eq("company_id", context.activeCompany.companyId)
      .order("name")
      .returns<Row[]>();

    for (const item of data ?? []) {
      lines.push(
        [
          cell(item.name),
          cell(item.inventory_categories?.name ?? ""),
          cell(item.unit_of_measure),
          cell(Number(item.reorder_level)),
          cell(Number(item.unit_cost)),
          cell(item.sku),
          cell(Number(item.quantity_on_hand)),
        ].join(","),
      );
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = templateOnly
    ? "inventory-import-template.csv"
    : `inventory-${stamp}.csv`;

  // The BOM makes Excel read it as UTF-8, so the peso sign and accented names
  // do not arrive mangled.
  return new NextResponse(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
