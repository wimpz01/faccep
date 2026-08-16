import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Reports" };

const REPORTS: {
  href: string;
  title: string;
  description: string;
  moduleKey: string;
}[] = [
  {
    href: "/reports/receivables",
    title: "Receivables & aging",
    description:
      "Customer balances, aged 1–30 / 31–60 / 61–90 / 90+, with the late-payment list.",
    moduleKey: MODULE.reportsReceivables,
  },
  {
    href: "/reports/collections",
    title: "Collection report",
    description: "Payments received over a date range, by mode and by tenant.",
    moduleKey: MODULE.reportsReceivables,
  },
  {
    href: "/payments/pdc/deposit-slip",
    title: "Cheque deposit slip",
    description:
      "Matured, undeposited cheques grouped by bank, ready to print and hand over the counter.",
    moduleKey: MODULE.paymentsPdc,
  },
  {
    href: "/reports/payables",
    title: "Supplier aging",
    description: "What is owed to suppliers and how overdue it is.",
    moduleKey: MODULE.reportsExpenses,
  },
  {
    href: "/reports/income",
    title: "Income per location",
    description: "Invoiced revenue by month and by location.",
    moduleKey: MODULE.reportsSales,
  },
  {
    href: "/reports/tenants",
    title: "Tenants & deposits",
    description:
      "Active tenants, security deposits held, and available units with their rates.",
    moduleKey: MODULE.reportsTenants,
  },
  {
    href: "/reports/utilities",
    title: "Utility over/loss",
    description:
      "Provider consumption against tenant-billed totals, period by period.",
    moduleKey: MODULE.reportsUtilities,
  },
  {
    href: "/reports/maintenance",
    title: "Maintenance cost",
    description: "Job costs by location, split between in-house and contracted.",
    moduleKey: MODULE.reportsMaintenance,
  },
  {
    href: "/reports/tax",
    title: "Tax: 2307, 1601-EQ, VAT relief",
    description:
      "Creditable withholding tax per supplier, the quarterly remittance summary, and VATable sales.",
    moduleKey: MODULE.reportsTax,
  },
  {
    href: "/accounting/reports",
    title: "Financial statements",
    description:
      "Income statement, balance sheet, trial balance and cash flow — together or one at a time.",
    moduleKey: MODULE.reportsFinancials,
  },
  {
    href: "/accounting/reports/quarterly",
    title: "Quarterly income comparison",
    description:
      "The income statement read across the year, one quarter beside another.",
    moduleKey: MODULE.reportsFinancials,
  },
];

export default async function ReportsIndexPage() {
  const context = await requireSession();
  const available = REPORTS.filter((report) =>
    can(context.permissions, report.moduleKey, "view"),
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every report reads live system data and is printable. None of them are editable."
      />

      {available.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {available.map((report) => (
            <Link key={report.href} href={report.href} className="card">
              <div className="card-body">
                <p
                  className="font-semibold text-sm"
                  style={{ color: "var(--color-brand-600)" }}
                >
                  {report.title}
                </p>
                <p className="text-xs muted mt-1">{report.description}</p>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <p className="text-sm muted">
            Your role does not include access to any reports yet.
          </p>
        </Card>
      )}
    </>
  );
}
