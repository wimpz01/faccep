export const JOURNAL_STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  posted: "badge badge-brand",
  reversed: "badge",
  cancelled: "badge",
};

export const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"] as const;

export const TYPE_LABELS: Record<string, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
