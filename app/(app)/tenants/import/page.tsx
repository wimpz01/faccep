import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { MODULE } from "@/lib/permissions";

import { importTenants } from "../actions";
import { ImportTenantsForm } from "../tenant-form";

export const metadata: Metadata = { title: "Import tenants" };

export default async function ImportTenantsPage() {
  await requirePermission(MODULE.tenants, "edit");

  return (
    <>
      <PageHeader
        title="Import tenants"
        description="Bring your existing tenant list in from a spreadsheet, instead of typing them in one by one."
        action={
          <Link href="/tenants" className="btn btn-secondary btn-sm">
            Back to tenants
          </Link>
        }
      />

      <div className="mb-5">
        <Card title="Spreadsheet">
          <ImportTenantsForm action={importTenants} />
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
              <tr>
                <td className="text-sm">company_name</td>
                <td className="text-xs">yes</td>
                <td className="text-xs">
                  The tenant&rsquo;s registered or trading name. Must not already
                  be on file.
                </td>
              </tr>
              <tr>
                <td className="text-sm">tin</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">
                  Printed on their invoices. Leave blank if you do not have it
                  yet.
                </td>
              </tr>
              <tr>
                <td className="text-sm">is_vatable</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">
                  <strong>yes</strong> or <strong>no</strong>. Decides whether
                  VAT is added to their billing. Blank means no.
                </td>
              </tr>
              <tr>
                <td className="text-sm">address</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">Their billing address.</td>
              </tr>
              <tr>
                <td className="text-sm">contact_person</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">Who you deal with.</td>
              </tr>
              <tr>
                <td className="text-sm">mobile_number</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">Contact number.</td>
              </tr>
              <tr>
                <td className="text-sm">email</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">
                  Must look like an email if given, or the file is refused.
                </td>
              </tr>
              <tr>
                <td className="text-sm">company_number</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">SEC or DTI registration number.</td>
              </tr>
              <tr>
                <td className="text-sm">notes</td>
                <td className="text-xs muted">no</td>
                <td className="text-xs">Anything worth remembering.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs muted px-5 pb-4">
          Column order does not matter — the header row is what is read, so you
          may leave optional columns out entirely. Only the tenant record is
          imported: units, contracts, rent and deposits carry their own dates
          and money, and are set up per tenant afterwards.
        </p>
      </Card>
    </>
  );
}
