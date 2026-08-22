import { redirect } from "next/navigation";

import { PrintStamp } from "@/components/print-stamp";
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

  // Everyone who can approve anything needs the queue; it self-filters per row.
  const hasAnyApprove = Object.values(permissions).some((entry) => entry.approve);

  if (context.activeCompany) {
    // The dashboard is where every session starts, so it is a link at the very
    // top rather than a row inside a drawer that has to be opened first. A
    // one-item group renders as the link itself.
    groups.push({
      group: "Dashboard",
      items: [{ href: "/dashboard", label: "Dashboard" }],
    });

    const overview: NavItem[] = [
      // Available to everyone: it is where you change your own password.
      { href: "/account", label: "My account" },
    ];
    if (hasAnyApprove) {
      overview.push({ href: "/approvals", label: "Approvals" });
    }
    groups.push({ group: "Overview", items: overview });
  }

  const portfolio: NavItem[] = [];
  /*
   * Locations lead the portfolio rather than sitting in Administration. A
   * location is the thing units, tenants and billing all hang off, which makes
   * it the start of the property list, not a settings chore.
   */
  if (can(permissions, MODULE.adminLocations, "view")) {
    portfolio.push({ href: "/portfolio/locations", label: "Locations" });
  }
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
  if (can(permissions, MODULE.billingInvoices, "edit")) {
    billing.push({
      href: "/billing/invoices/print-layout",
      label: "Billing print layout",
    });
  }
  if (can(permissions, MODULE.payments, "view")) {
    billing.push({ href: "/payments", label: "Payments" });
  }
  // Sits with billing rather than with the lease: it is a transaction, and the
  // cashier who pays the refund out needs to reach it.
  if (can(permissions, MODULE.contractDeposits, "view")) {
    billing.push({ href: "/deposits", label: "Deposit settlement" });
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
  if (operations.length > 0) {
    groups.push({ group: "Operations", items: operations });
  }

  /**
   * Inventory stands on its own rather than sitting inside Operations. It is
   * several jobs, not one screen -- keeping stock, adjusting it, and answering
   * where it went -- and each wants its own way in.
   */
  const inventory: NavItem[] = [];
  if (can(permissions, MODULE.inventoryItems, "view")) {
    inventory.push({ href: "/inventory", label: "Item list" });
  }
  if (can(permissions, MODULE.inventoryItems, "edit")) {
    inventory.push({ href: "/inventory/new", label: "Add new item" });
    inventory.push({ href: "/inventory/import", label: "Import a list" });
  }
  if (can(permissions, MODULE.inventoryMovements, "view")) {
    inventory.push({ href: "/inventory/adjustments", label: "Stock adjustment" });
    inventory.push({ href: "/inventory/history", label: "Movement history" });
  }
  if (can(permissions, MODULE.inventoryItems, "view")) {
    inventory.push({ href: "/inventory/categories", label: "Categories" });
    inventory.push({ href: "/inventory/non-stock", label: "Non-stock items" });
    inventory.push({ href: "/inventory/accounts", label: "Item accounts" });
  }
  if (can(permissions, MODULE.inventoryTools, "view")) {
    inventory.push({ href: "/inventory/tools", label: "Tools & equipment" });
  }
  if (inventory.length > 0) {
    groups.push({ group: "Inventory", items: inventory });
  }

  const purchasing: NavItem[] = [];
  if (can(permissions, MODULE.purchasingRequests, "view")) {
    purchasing.push({ href: "/purchasing/requests", label: "Purchase requests" });
  }
  if (can(permissions, MODULE.purchasingOrders, "view")) {
    purchasing.push({ href: "/purchasing/orders", label: "Purchase orders" });
  }
  // Receiving is done on the order itself, so it has no screen of its own.
  // Without an entry here the module is invisible: someone granted Receiving
  // opens the menu, finds nothing, and concludes they were not given it. The
  // link lands on the orders still awaiting delivery -- the only ones goods
  // can be received against.
  if (
    can(permissions, MODULE.purchasingReceiving, "view") &&
    can(permissions, MODULE.purchasingOrders, "view")
  ) {
    purchasing.push({
      href: "/purchasing/orders?view=outstanding",
      label: "Receiving",
    });
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
  if (can(permissions, MODULE.accountingTax, "view")) {
    accounting.push({ href: "/accounting/taxes", label: "Tax settings" });
  }
  if (can(permissions, MODULE.reportsFinancials, "view")) {
    accounting.push({ href: "/accounting/reports", label: "Financial statements" });
  }
  if (accounting.length > 0) {
    groups.push({ group: "Accounting", items: accounting });
  }

  // Reports keep a heading of their own: they are read across the whole
  // business, not only off the ledger, and several readers have them without
  // any accounting access at all.
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

  // Billing, maintenance and accounting arrive in later phases and add their
  // own entries here, gated the same way.
  const administration: NavItem[] = [];
  if (context.isSuperAdmin || can(permissions, MODULE.adminCompanies, "view")) {
    administration.push({ href: "/admin/companies", label: "Companies" });
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
      {/* Every printable document carries when it was printed, so no page
          has to remember to add it. Hidden on screen. */}
      <PrintStamp />
    </div>
  );
}
