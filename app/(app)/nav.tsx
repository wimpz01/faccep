"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { signOut } from "@/app/login/actions";
import { setActiveCompany } from "./actions";

export type NavItem = {
  href: string;
  label: string;
  /**
   * Sections within the page, shown only while that page is open.
   *
   * They point at the page's own tabs, so the sidebar and the tab bar are the
   * same navigation rather than two competing ones. Kept out of the tree until
   * the parent is active, or every page's internals would crowd the sidebar.
   */
  children?: NavItem[];
};
export type NavGroup = { group: string; items: NavItem[] };

export type NavCompany = { id: string; name: string };

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 150ms ease",
        flexShrink: 0,
      }}
    >
      <path
        d="M4 2.5 L8 6 L4 9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppNav({
  groups,
  companies,
  activeCompanyId,
  userName,
  userEmail,
  userCode,
  roleName,
}: {
  groups: NavGroup[];
  companies: NavCompany[];
  activeCompanyId: string;
  userName: string;
  userEmail: string;
  userCode: string;
  roleName: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  // The section holding the current page drives which drawer starts open, and
  // re-opens it after navigating somewhere the user had collapsed.
  const activeGroup =
    groups.find(({ items }) =>
      items.some((item) => isActive(pathname, item.href.split("?")[0])),
    )?.group ?? null;

  const [expanded, setExpanded] = useState<string[]>(
    activeGroup ? [activeGroup] : [],
  );

  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((current) =>
      current.includes(activeGroup) ? current : [...current, activeGroup],
    );
  }, [activeGroup]);

  /** The ?tab= a child link points at, if any. */
  function tabOf(href: string) {
    return href.split("?tab=")[1] ?? null;
  }

  /**
   * Whether an entry is the one being looked at.
   *
   * Entries that name a ?tab= all share one path, so the pathname alone cannot
   * tell them apart -- without this every tab of a page lights up at once. The
   * first tab entry for a path is that page's default view, and is the one lit
   * when the URL names no tab.
   */
  function isCurrent(item: NavItem, siblings: NavItem[]) {
    const base = item.href.split("?")[0];
    if (!isActive(pathname, base)) return false;

    const tab = tabOf(item.href);
    if (tab === null) return true;

    const first = siblings.find(
      (row) => row.href.split("?")[0] === base && tabOf(row.href) !== null,
    );
    return (searchParams.get("tab") ?? tabOf(first?.href ?? "")) === tab;
  }

  function itemLink(item: NavItem, indented: boolean, siblings: NavItem[]) {
    const active = isCurrent(item, siblings);
    return (
      <Link
        href={item.href}
        onClick={() => setOpen(false)}
        className={`block rounded-lg py-2 text-sm font-medium ${
          indented ? "pl-6 pr-3" : "px-3"
        }`}
        style={
          active
            ? { background: "var(--color-brand-600)", color: "#fff" }
            : { color: "var(--text)" }
        }
      >
        {item.label}
      </Link>
    );
  }

  /** An entry plus, while it is open, the sections inside it. */
  function itemBlock(item: NavItem, indented: boolean, siblings: NavItem[]) {
    const onThisPage = isActive(pathname, item.href.split("?")[0]);
    const children = onThisPage ? (item.children ?? []) : [];
    // The first child is the page's default view, so it is the one lit when no
    // tab is named in the URL.
    const currentTab = searchParams.get("tab") ?? tabOf(children[0]?.href ?? "");

    return (
      <div key={item.href}>
        {itemLink(item, indented, siblings)}
        {children.length > 0 ? (
          <ul className="flex flex-col gap-0.5 mt-0.5 mb-1">
            {children.map((child) => {
              const on = tabOf(child.href) === currentTab;
              return (
                <li key={child.href}>
                  <Link
                    href={child.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-lg py-1.5 text-xs"
                    style={{
                      paddingLeft: indented ? "2.25rem" : "1.5rem",
                      paddingRight: "0.75rem",
                      color: on ? "var(--color-brand-600)" : "var(--text)",
                      fontWeight: on ? 600 : 400,
                    }}
                  >
                    {child.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    );
  }

  const links = (
    <nav className="flex flex-col gap-1">
      {groups.map(({ group, items }) => {
        // A section with a single destination is the destination -- collapsing
        // it would hide one link behind one click.
        if (items.length === 1) {
          return <div key={group}>{itemBlock(items[0], false, items)}</div>;
        }

        const isOpen = expanded.includes(group);
        const holdsActive = group === activeGroup;
        const panelId = `nav-${group.replace(/\s+/g, "-").toLowerCase()}`;

        return (
          <div key={group}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() =>
                setExpanded((current) =>
                  current.includes(group)
                    ? current.filter((name) => name !== group)
                    : [...current, group],
                )
              }
              className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-left"
              style={{ color: "var(--text)" }}
            >
              <Chevron open={isOpen} />
              <span className="flex-1">{group}</span>
              {!isOpen && holdsActive ? (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--color-brand-600)" }}
                />
              ) : null}
            </button>

            {isOpen ? (
              <ul id={panelId} className="flex flex-col gap-0.5 mt-0.5 mb-1">
                {items.map((item) => (
                  <li key={item.href}>{itemBlock(item, true, items)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile bar */}
      <header
        className="no-print lg:hidden sticky top-0 z-30 flex items-center justify-between gap-3 px-4 h-14 border-b"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="app-sidebar"
        >
          {open ? "Close" : "Menu"}
        </button>
        <span className="font-bold tracking-tight">Night Rider</span>
        <form action={signOut}>
          <button type="submit" className="btn btn-secondary btn-sm">
            Sign out
          </button>
        </form>
      </header>

      <aside
        id="app-sidebar"
        className={`no-print ${
          open ? "block" : "hidden"
        } lg:block lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 border-r p-4 overflow-y-auto`}
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="hidden lg:flex items-center gap-2.5 mb-5 px-1">
          <div
            className="h-9 w-9 rounded-lg bg-brand-600 text-white grid place-items-center font-bold"
            style={{ letterSpacing: "-0.04em" }}
          >
            NR
          </div>
          <div>
            <p className="font-bold leading-tight tracking-tight">Night Rider</p>
            <p className="text-[0.7rem] muted leading-tight">
              Property Management
            </p>
          </div>
        </div>

        {companies.length > 0 ? (
          <form action={setActiveCompany} className="mb-5">
            <label className="label" htmlFor="companyId">
              Company
            </label>
            <select
              id="companyId"
              name="companyId"
              className="select"
              defaultValue={activeCompanyId}
              onChange={(event) => event.currentTarget.form?.requestSubmit()}
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <noscript>
              <button type="submit" className="btn btn-secondary btn-sm mt-2">
                Switch
              </button>
            </noscript>
          </form>
        ) : null}

        {links}

        <div
          className="mt-6 pt-4 border-t text-xs"
          style={{ borderColor: "var(--border)" }}
        >
          <p className="font-semibold">{userName}</p>
          <p className="muted break-all">{userEmail}</p>
          {userCode ? (
            <p className="muted">
              Code <strong>{userCode}</strong>
            </p>
          ) : null}
          <p className="mt-1">
            <span className="badge badge-brand">{roleName}</span>
          </p>
          <form action={signOut} className="mt-3 hidden lg:block">
            <button type="submit" className="btn btn-secondary btn-sm w-full">
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
