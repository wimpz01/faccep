import type { Metadata } from "next";
import Link from "next/link";

import { CsvImportForm } from "@/components/csv-import-form";
import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";

import { importContracts } from "../import-actions";

export const metadata: Metadata = { title: "Import contracts" };

const COLUMNS = [
  {
    name: "tenant",
    required: true,
    what: "The tenant's name exactly as it is on file. Import the tenants first if they are not.",
  },
  {
    name: "unit_codes",
    required: true,
    what: "The unit, or several separated by a semicolon. Write PROPERTY/UNIT where two properties share a unit code — BLDG-A/201.",
  },
  {
    name: "contract_no",
    required: false,
    what: "Your own reference. Leave blank and one is issued from the series.",
  },
  {
    name: "status",
    required: false,
    what: "draft, active, expired or terminated. Blank means active.",
  },
  { name: "start_date", required: true, what: "YYYY-MM-DD." },
  {
    name: "end_date",
    required: false,
    what: "YYYY-MM-DD. Blank is treated as the start date.",
  },
  { name: "monthly_rent", required: true, what: "The agreed rent." },
  {
    name: "security_deposit",
    required: false,
    what: "What was taken as a deposit. Blank means nought.",
  },
  {
    name: "advance_payment",
    required: false,
    what: "Advance rent held. Blank means nought.",
  },
  {
    name: "rent_due_day",
    required: false,
    what: "Day of the month rent falls due, 1 to 28. Blank means 5.",
  },
  { name: "notes", required: false, what: "Anything worth remembering." },
];

export default async function ImportContractsPage() {
  await requirePermission(MODULE.contracts, "edit");

  return (
    <>
      <PageHeader
        title="Import contracts"
        description="Bring existing leases in from a spreadsheet. Tenants and units must be in first."
        action={
          <Link href="/contracts" className="btn btn-secondary btn-sm">
            Back to contracts
          </Link>
        }
      />

      <div className="mb-5">
        <Card title="Spreadsheet">
          <CsvImportForm
            action={importContracts}
            idPrefix="contract-import"
            templateHref="/contracts/template"
            placeholder={
              "tenant,unit_codes,status,start_date,end_date,monthly_rent,security_deposit,advance_payment,rent_due_day\nSunrise Hardware Trading,BLDG-A/201,active,2026-01-01,2026-12-31,25000,50000,25000,5"
            }
            requiredNote={
              <>
                <strong>tenant</strong>, <strong>unit_codes</strong>,{" "}
                <strong>start_date</strong> and <strong>monthly_rent</strong> are
                required.
              </>
            }
            submitLabel="Import contracts"
          />
        </Card>
      </div>

      {/* Two rules behave differently on an import, and both are worth saying
          before somebody wonders why. */}
      <div className="mb-5">
        <Card title="Two things worth knowing">
          <ul className="text-sm" style={{ paddingLeft: "1.1rem" }}>
            <li style={{ marginBottom: "0.5rem" }}>
              A contract written in the app cannot be priced below the unit&rsquo;s
              rate. An import can: these are leases already signed, and one
              running at a rent the unit has since outgrown is a fact to record
              rather than a decision being made now.
            </li>
            <li>
              A unit already on a live contract is refused, and so is a unit
              named twice in the same file. One unit cannot be let twice over,
              and letting it through would leave occupancy and the rent roll
              wrong in a way nobody would spot until a bill went out.
            </li>
          </ul>
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
          Column order does not matter — the header row is what is read. Utility
          billing terms, escalation and penalties are not imported: they carry
          their own rules and are set on the contract afterwards.
        </p>
      </Card>
    </>
  );
}
