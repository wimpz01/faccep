import type { Metadata } from "next";
import Link from "next/link";

import { CsvImportForm } from "@/components/csv-import-form";
import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";

import { importUnits } from "../import-actions";

export const metadata: Metadata = { title: "Import units" };

const COLUMNS = [
  {
    name: "location_code",
    required: true,
    what: "The code of the property this unit is in, like BLDG-A. It has to exist already.",
  },
  {
    name: "code",
    required: true,
    what: "Unit code, like 201 or Door A. Must be unique within its property.",
  },
  { name: "floor", required: false, what: "Ground, Second, and so on." },
  { name: "area_sqm", required: false, what: "Floor area in square metres." },
  {
    name: "monthly_rate",
    required: false,
    what: "The asking rent. Needs Approve on units to import — see the note below. Blank means no rate yet.",
  },
  { name: "description", required: false, what: "Anything worth noting." },
  {
    name: "water_meter_serial",
    required: false,
    what: "Sub-meter serial, used when utilities are billed.",
  },
  {
    name: "electric_meter_serial",
    required: false,
    what: "Sub-meter serial, used when utilities are billed.",
  },
];

export default async function ImportUnitsPage() {
  const context = await requirePermission(MODULE.units, "edit");
  const mayApproveRates = can(context.permissions, MODULE.units, "approve");

  return (
    <>
      <PageHeader
        title="Import units"
        description="Bring your unit list in from a spreadsheet. The properties they belong to must be in first."
        action={
          <Link href="/properties" className="btn btn-secondary btn-sm">
            Back to properties
          </Link>
        }
      />

      <div className="mb-5">
        <Card title="Spreadsheet">
          <CsvImportForm
            action={importUnits}
            idPrefix="unit-import"
            templateHref="/properties/template"
            placeholder={
              "location_code,code,floor,area_sqm,monthly_rate,description\nBLDG-A,201,Second,48,25000,Corner unit"
            }
            requiredNote={
              <>
                <strong>location_code</strong> and <strong>code</strong> are
                required.
              </>
            }
            submitLabel="Import units"
          />
        </Card>
      </div>

      {/* The rate is the one column with a rule behind it, so it is said here
          rather than left to be discovered when the file is refused. */}
      <div className="mb-5">
        <Card title="About the rate">
          {mayApproveRates ? (
            <p className="text-sm">
              A unit&rsquo;s rate normally moves only with approval. On an import
              the proposal is still raised and then signed off in your name, so
              the rate history reads as it would for any other change — proposed,
              approved, by you, today — and the units can be let straight away.
            </p>
          ) : (
            <p className="text-sm">
              You can import units but not their rates: setting a rate needs
              Approve on units. Leave <strong>monthly_rate</strong> blank and
              have somebody price them afterwards, or ask an approver to run the
              import.
            </p>
          )}
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
          Column order does not matter — the header row is what is read. A unit
          is created vacant; occupancy follows from contracts, not from a
          spreadsheet.
        </p>
      </Card>
    </>
  );
}
