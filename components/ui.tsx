import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm muted mt-0.5">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  bodyClassName = "card-body",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="card">
      {title ? (
        <div className="card-header">
          <div>
            <h2 className="font-semibold text-sm">{title}</h2>
            {description ? (
              <p className="text-xs muted mt-0.5">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "money";
}) {
  return (
    <div className="card">
      <div className="card-body">
        <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
          {label}
        </p>
        <p
          className="text-3xl font-bold mt-1 tabular-nums tracking-tight"
          style={tone === "money" ? { color: "var(--color-gold-500)" } : undefined}
        >
          {value}
        </p>
        {hint ? <p className="text-xs muted mt-1">{hint}</p> : null}
      </div>
    </div>
  );
}

/** Renders a server-action error passed back through useActionState. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
