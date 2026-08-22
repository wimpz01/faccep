import type { Metadata } from "next";
import Link from "next/link";

import { CsvImportForm } from "@/components/csv-import-form";
import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";

import { importLocations } from "../import-actions";

export const metadata: Metadata = { title: "Import locations" };

const COLUMNS = [
  {
    name: "code",
    required: true,
    what: "Short code you know the location by, like BLDG-C. Must not already be on file.",
  },
  { name: "name", required: true, what: "The location's full name." },
  {
    name: "property_type",
    required: false,
    what: "One of commercial_building, office, warehouse, vacant_lot or apartment. Spaces and capitals are forgiven.",
  },
  { name: "address", required: false, what: "Where it is." },
  {
    name: "is_active",
    required: false,
    what: "yes or no. Blank means yes.",
  },
];

export default async function ImportLocationsPage() {
  await requirePermission(MODULE.adminLocations, "edit");

  return (
    <>
      <PageHeader
        title="Import locations"
        description="Bring your location list in from a spreadsheet. Locations go in first — units and contracts hang off them."
        action={
          <Link href="/portfolio/locations" className="btn btn-secondary btn-sm">
            Back to locations
          </Link>
        }
      />

      <div className="mb-5">
        <Card title="Spreadsheet">
          <CsvImportForm
            action={importLocations}
            idPrefix="location-import"
            templateHref="/portfolio/locations/template"
            placeholder={
              "code,name,property_type,address,is_active\nBLDG-C,Riverside Arcade,commercial_building,12 Riverside Road,yes"
            }
            requiredNote={
              <>
                <strong>code</strong> and <strong>name</strong> are required.
              </>
            }
            submitLabel="Import locations"
          />
        </Card>
      </div>

      <Card title="What the columns mean">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Column</th>
                <th>Required</th>
                <th>What to put in it</th>
              </tr>
            </thead>
            <tbody>
              {COLUMNS.map((column) => (
                <tr key={column.name}>
                  <td className="text-sm">{column.name}</td>
                  <td className={column.required ? "text-xs" : "text-xs muted"}>
                    {column.required ? "yes" : "no"}
                  </td>
                  <td className="text-xs">{column.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs muted px-5 pb-4">
          Column order does not matter — the header row is what is read, so
          optional columns may be left out entirely. The invoice letter is not a
          column: each property is given its own automatically, so its invoices
          number as A-26-00001, B-26-00001 and so on.
        </p>
      </Card>
    </>
  );
}
