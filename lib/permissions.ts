/**
 * Permission vocabulary shared by the server helpers and the admin UI.
 *
 * The authoritative matrix lives in the database (role_permissions plus
 * user_permissions overrides, resolved by the has_permission / my_permissions
 * SQL functions). This file only mirrors the module *keys* so that call sites
 * are typo-checked at compile time.
 */

export const PERMISSION_ACTIONS = [
  "view",
  "edit",
  "delete",
  "approve",
  "void",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const ACTION_LABELS: Record<PermissionAction, string> = {
  view: "View",
  edit: "Edit",
  delete: "Delete",
  approve: "Approve",
  void: "Void",
};

export const ACTION_HINTS: Record<PermissionAction, string> = {
  view: "See the module and its records, but change nothing.",
  edit: "See and save. Cannot delete.",
  delete: "See, save and delete.",
  approve: "Sign off items that require approval.",
  void: "Reverse a posted record. Still requires approval to take effect.",
};

/** Module keys seeded by supabase/migrations/0003_seed_modules.sql. */
export const MODULE = {
  dashboardIncome: "dashboard.income",
  dashboardOccupancy: "dashboard.occupancy",
  dashboardUtilities: "dashboard.utilities",
  dashboardExpenses: "dashboard.expenses",
  dashboardNotifications: "dashboard.notifications",
  dashboardCheques: "dashboard.cheques",
  tenants: "tenants",
  contracts: "contracts",
  contractDeposits: "contracts.deposits",
  clearance: "clearance",
  properties: "properties",
  units: "units",
  billingMeterReadings: "billing.meter_readings",
  billingUtilityRates: "billing.utility_rates",
  billingInvoices: "billing.invoices",
  billingCreditMemos: "billing.credit_memos",
  payments: "payments",
  paymentsPdc: "payments.pdc",
  maintenanceScheduled: "maintenance.scheduled",
  maintenanceRepairs: "maintenance.repairs",
  maintenanceMaterialRequests: "maintenance.material_requests",
  maintenanceProgressSignoff: "maintenance.progress_signoff",
  inventoryItems: "inventory.items",
  inventoryMovements: "inventory.movements",
  inventoryTools: "inventory.tools",
  purchasingRequests: "purchasing.requests",
  purchasingOrders: "purchasing.orders",
  purchasingReceiving: "purchasing.receiving",
  purchasingVendors: "purchasing.vendors",
  payablesInvoices: "payables.invoices",
  payablesVouchers: "payables.vouchers",
  payablesPayments: "payables.payments",
  accountingCoa: "accounting.coa",
  accountingJournal: "accounting.journal",
  accountingAr: "accounting.ar",
  accountingAp: "accounting.ap",
  accountingPeriods: "accounting.periods",
  accountingTax: "accounting.tax",
  reportsReceivables: "reports.receivables",
  reportsSales: "reports.sales",
  reportsExpenses: "reports.expenses",
  reportsTenants: "reports.tenants",
  reportsUtilities: "reports.utilities",
  reportsMaintenance: "reports.maintenance",
  reportsFinancials: "reports.financials",
  reportsTax: "reports.tax",
  bankDeposits: "bank.deposits",
  crmInquiries: "crm.inquiries",
  crmComplaints: "crm.complaints",
  calendar: "calendar",
  documents: "documents",
  adminCompanies: "admin.companies",
  adminLocations: "admin.locations",
  adminUsers: "admin.users",
  adminRoles: "admin.roles",
  adminAudit: "admin.audit",
} as const;

export type ModuleKey = (typeof MODULE)[keyof typeof MODULE];

export type ModulePermissions = Record<PermissionAction, boolean>;

/** module key -> resolved permissions for the current user in one company. */
export type PermissionMatrix = Record<string, ModulePermissions>;

export const NO_PERMISSIONS: ModulePermissions = {
  view: false,
  edit: false,
  delete: false,
  approve: false,
  void: false,
};

/**
 * What a role may do with a module.
 *
 * The first three rights are a ladder, not independent switches:
 *
 *   revoked  no access at all — the module is not even visible
 *   view     read it, change nothing
 *   edit     read and save, but not delete
 *   delete   read, save and delete
 *
 * so delete implies edit and edit implies view. Approve and void sit apart:
 * they are sign-off rights that some modules do not offer, and they still
 * require view, because signing off on something you cannot see is not a
 * coherent right.
 *
 * Resolved here rather than trusted from the database, so a row saved by an
 * older screen — or edited directly — cannot grant edit on a module the role
 * is not allowed to open. Page guards ask for view; action guards ask for
 * edit, and without this the two could disagree.
 */
export function permissionsFor(
  matrix: PermissionMatrix,
  moduleKey: string,
): ModulePermissions {
  const granted = matrix[moduleKey];
  if (!granted || !granted.view) return NO_PERMISSIONS;

  return {
    view: true,
    edit: granted.edit || granted.delete,
    delete: granted.delete,
    approve: granted.approve,
    void: granted.void,
  };
}

export function can(
  matrix: PermissionMatrix,
  moduleKey: string,
  action: PermissionAction,
): boolean {
  return permissionsFor(matrix, moduleKey)[action];
}

export type ModuleRow = {
  key: string;
  label: string;
  module_group: string;
  description: string | null;
  sort_order: number;
  supports_approve: boolean;
  supports_void: boolean;
};

/** Groups the module registry for the permission-matrix editor. */
export function groupModules(modules: ModuleRow[]) {
  const groups = new Map<string, ModuleRow[]>();
  for (const mod of modules) {
    const list = groups.get(mod.module_group) ?? [];
    list.push(mod);
    groups.set(mod.module_group, list);
  }
  return [...groups.entries()].map(([group, items]) => ({
    group,
    items: items.sort((a, b) => a.sort_order - b.sort_order),
  }));
}
