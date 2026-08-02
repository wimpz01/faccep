import { redirect } from "next/navigation";

import { requireSession } from "@/lib/auth";
import { MODULE, can } from "@/lib/permissions";

import { AppNav, type NavGroup, type NavItem } from "./nav";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const context = await requireSession();

  // A super admin on a fresh install has no company yet, and needs to reach
  // the Companies page to create the first one -- so only ordinary users are
  // bounced out.
  if (!context.activeCompany && !context.isSuperAdmin) redirect("/no-company");

  const permissions = context.permissions;

  const groups: NavGroup[] = [];
  if (context.activeCompany) {
    groups.push({
      group: "Overview",
      items: [
        { href: "/dashboard", label: "Dashboard" },
        // Available to everyone: it is where you change your own password.
        { href: "/account", label: "My account" },
      ],
    });
  }

  const portfolio: NavItem[] = [];
  if (can(permissions, MODULE.properties, "view")) {
    portfolio.push({ href: "/properties", label: "Properties & Units" });
  }
  if (can(permissions, MODULE.tenants, "view")) {
    portfolio.push({ href: "/tenants", label: "Tenants" });
  }
  if (can(permissions, MODULE.contracts, "view")) {
    portfolio.push({ href: "/contracts", label: "Contracts" });
  }
  if (portfolio.length > 0) {
    groups.push({ group: "Portfolio", items: portfolio });
  }

  const billing: NavItem[] = [];
  if (can(permissions, MODULE.billingUtilityRates, "view")) {
    billing.push({ href: "/billing/periods", label: "Utility periods" });
  }
  if (can(permissions, MODULE.billingInvoices, "view")) {
    billing.push({ href: "/billing/invoices", label: "Invoices" });
  }
  if (can(permissions, MODULE.payments, "view")) {
    billing.push({ href: "/payments", label: "Payments" });
  }
  if (can(permissions, MODULE.paymentsPdc, "view")) {
    billing.push({ href: "/payments/pdc", label: "Postdated cheques" });
  }
  if (billing.length > 0) {
    groups.push({ group: "Billing", items: billing });
  }

  const operations: NavItem[] = [];
  if (can(permissions, MODULE.maintenanceRepairs, "view")) {
    operations.push({ href: "/maintenance/jobs", label: "Repair jobs" });
  }
  if (can(permissions, MODULE.maintenanceScheduled, "view")) {
    operations.push({ href: "/maintenance/schedules", label: "Scheduled maintenance" });
  }
  if (can(permissions, MODULE.inventoryItems, "view")) {
    operations.push({ href: "/inventory", label: "Inventory" });
  }
  if (can(permissions, MODULE.inventoryTools, "view")) {
    operations.push({ href: "/inventory/tools", label: "Tools & equipment" });
  }
  if (operations.length > 0) {
    groups.push({ group: "Operations", items: operations });
  }

  const purchasing: NavItem[] = [];
  if (can(permissions, MODULE.purchasingRequests, "view")) {
    purchasing.push({ href: "/purchasing/requests", label: "Purchase requests" });
  }
  if (can(permissions, MODULE.purchasingOrders, "view")) {
    purchasing.push({ href: "/purchasing/orders", label: "Purchase orders" });
  }
  if (can(permissions, MODULE.purchasingVendors, "view")) {
    purchasing.push({ href: "/purchasing/vendors", label: "Suppliers" });
  }
  if (purchasing.length > 0) {
    groups.push({ group: "Purchasing", items: purchasing });
  }

  // Payables stands beside Purchasing rather than inside it: buying and paying
  // are separate jobs, usually separate people, and separate permissions.
  const payables: NavItem[] = [];
  if (can(permissions, MODULE.payablesInvoices, "view")) {
    payables.push({ href: "/payables?tab=invoices", label: "Supplier invoices" });
  }
  if (can(permissions, MODULE.payablesInvoices, "edit")) {
    payables.push({ href: "/payables?tab=record", label: "Record invoice" });
  }
  if (can(permissions, MODULE.payablesInvoices, "view")) {
    payables.push({
      href: "/payables?tab=receipts",
      label: "Received, not billed",
    });
  }
  if (can(permissions, MODULE.payablesVouchers, "view")) {
    payables.push({ href: "/payables?tab=vouchers", label: "Cheque vouchers" });
  }
  // The aging report lives under Payables as well as in All reports: it is
  // read while working the ledger, not only at month end.
  if (can(permissions, MODULE.reportsExpenses, "view")) {
    payables.push({ href: "/reports/payables", label: "Supplier aging" });
  }
  if (payables.length > 0) {
    groups.push({ group: "Payables", items: payables });
  }

  const accounting: NavItem[] = [];
  if (can(permissions, MODULE.accountingCoa, "view")) {
    accounting.push({ href: "/accounting/accounts", label: "Chart of accounts" });
  }
  if (can(permissions, MODULE.accountingJournal, "view")) {
    accounting.push({ href: "/accounting/journal", label: "Journal" });
  }
  if (can(permissions, MODULE.accountingPeriods, "view")) {
    accounting.push({ href: "/accounting/periods", label: "Periods" });
  }
  if (can(permissions, MODULE.reportsFinancials, "view")) {
    accounting.push({ href: "/accounting/reports", label: "Financial statements" });
  }
  if (accounting.length > 0) {
    groups.push({ group: "Accounting", items: accounting });
  }

  const relations: NavItem[] = [];
  if (can(permissions, MODULE.crmInquiries, "view")) {
    relations.push({ href: "/crm/inquiries", label: "Inquiries" });
  }
  if (can(permissions, MODULE.crmComplaints, "view")) {
    relations.push({ href: "/crm/complaints", label: "Complaints" });
  }
  if (can(permissions, MODULE.calendar, "view")) {
    relations.push({ href: "/calendar", label: "Calendar" });
  }
  if (can(permissions, MODULE.documents, "view")) {
    relations.push({ href: "/documents", label: "Documents" });
  }
  if (relations.length > 0) {
    groups.push({ group: "Front office", items: relations });
  }

  const anyReport = [
    MODULE.reportsReceivables,
    MODULE.reportsSales,
    MODULE.reportsExpenses,
    MODULE.reportsTenants,
    MODULE.reportsUtilities,
    MODULE.reportsMaintenance,
    MODULE.reportsFinancials,
    MODULE.reportsTax,
  ].some((moduleKey) => can(permissions, moduleKey, "view"));
  if (anyReport) {
    groups.push({
      group: "Reports",
      items: [{ href: "/reports", label: "All reports" }],
    });
  }

  // Everyone who can approve anything needs the queue; it self-filters per row.
  const hasAnyApprove = Object.values(permissions).some((entry) => entry.approve);
  if (hasAnyApprove) {
    groups.push({
      group: "Workflow",
      items: [{ href: "/approvals", label: "Approvals" }],
    });
  }

  // Billing, maintenance and accounting arrive in later phases and add their
  // own entries here, gated the same way.
  const administration: NavItem[] = [];
  if (context.isSuperAdmin || can(permissions, MODULE.adminCompanies, "view")) {
    administration.push({ href: "/admin/companies", label: "Companies" });
  }
  if (can(permissions, MODULE.adminLocations, "view")) {
    administration.push({ href: "/admin/locations", label: "Locations" });
  }
  if (can(permissions, MODULE.adminUsers, "view")) {
    administration.push({ href: "/admin/users", label: "Users" });
  }
  if (can(permissions, MODULE.adminRoles, "view")) {
    administration.push({ href: "/admin/roles", label: "Roles & Permissions" });
  }
  if (can(permissions, MODULE.adminAudit, "view")) {
    administration.push({ href: "/admin/audit", label: "Audit Trail" });
  }
  // Backups read every table at once, so they are admin-only rather than
  // gated on a module permission.
  if (context.isSuperAdmin || context.activeCompany?.isCompanyAdmin) {
    administration.push({ href: "/admin/backups", label: "Backups" });
  }
  if (administration.length > 0) {
    groups.push({ group: "Administration", items: administration });
  }

  return (
    <div className="min-h-screen">
      <AppNav
        groups={groups}
        companies={context.memberships.map((membership) => ({
          id: membership.companyId,
          name: membership.companyName,
        }))}
        activeCompanyId={context.activeCompany?.companyId ?? ""}
        userName={context.fullName}
        userEmail={context.email}
        userCode={context.userCode}
        roleName={
          context.isSuperAdmin
            ? "Super admin"
            : context.activeCompany?.isCompanyAdmin
              ? "Company admin"
              : (context.activeCompany?.roleName ?? "No role assigned")
        }
      />
      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
          {!context.activeCompany ? (
            <div className="card mb-6">
              <div className="card-body">
                <p className="text-sm">
                  <strong>No company yet.</strong> Create the first company
                  below to start setting up locations, roles and users.
                </p>
              </div>
            </div>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}
