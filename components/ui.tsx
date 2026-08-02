import Link from "next/link";
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

/**
 * Section tabs within a page.
 *
 * Each tab is a link rather than client state, so a tab can be linked to,
 * bookmarked and reloaded, and the page stays a server component.
 */
export function TabBar({
  tabs,
  active,
}: {
  tabs: { value: string; label: string; href: string; count?: number }[];
  active: string;
}) {
  return (
    <div
      className="flex gap-1 flex-wrap border-b mb-6"
      style={{ borderColor: "var(--border)" }}
    >
      {tabs.map((tab) => {
        const on = tab.value === active;
        return (
          <a
            key={tab.value}
            href={tab.href}
            className="text-sm font-medium px-4 py-2.5"
            style={{
              color: on ? "var(--color-brand-600)" : "var(--text)",
              borderBottom: on
                ? "2px solid var(--color-brand-600)"
                : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="ml-1.5 text-xs muted tabular-nums">
                {tab.count}
              </span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

/**
 * A headline figure. Given an href it becomes the way into whatever it counts,
 * so a number on a dashboard is never a dead end.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "money";
  href?: string;
}) {
  const body = (
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
      {href ? (
        <p
          className="text-xs mt-2 font-semibold"
          style={{ color: "var(--color-brand-600)" }}
        >
          View detail →
        </p>
      ) : null}
    </div>
  );

  if (!href) return <div className="card">{body}</div>;

  return (
    <Link href={href} className="card stat-tile-link" style={{ display: "block" }}>
      {body}
    </Link>
  );
}

/**
 * Says which subset of a list is on screen, and how to get back to all of it.
 * Shown when a dashboard tile has been clicked through to its detail.
 */
export function FilterNote({
  label,
  count,
  clearHref,
}: {
  label: string;
  count: number;
  clearHref: string;
}) {
  return (
    <div
      className="card mb-4 no-print"
      style={{ borderColor: "var(--color-brand-600)" }}
    >
      <div className="card-body flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm">
          Showing <strong>{label}</strong> — {count} record(s).
        </p>
        <Link href={clearHref} className="btn btn-secondary btn-sm">
          Show all
        </Link>
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
