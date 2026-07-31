"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/app/login/actions";
import { setActiveCompany } from "./actions";

export type NavItem = { href: string; label: string };
export type NavGroup = { group: string; items: NavItem[] };

export type NavCompany = { id: string; name: string };

export function AppNav({
  groups,
  companies,
  activeCompanyId,
  userName,
  userEmail,
  roleName,
}: {
  groups: NavGroup[];
  companies: NavCompany[];
  activeCompanyId: string;
  userName: string;
  userEmail: string;
  roleName: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = (
    <nav className="flex flex-col gap-5">
      {groups.map(({ group, items }) => (
        <div key={group}>
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.08em] muted px-3 mb-1.5">
            {group}
          </p>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-medium"
                    style={
                      active
                        ? {
                            background: "var(--color-brand-600)",
                            color: "#fff",
                          }
                        : { color: "var(--text)" }
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile bar */}
      <header
        className="lg:hidden sticky top-0 z-30 flex items-center justify-between gap-3 px-4 h-14 border-b"
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
        <span className="font-bold tracking-tight">Faccep</span>
        <form action={signOut}>
          <button type="submit" className="btn btn-secondary btn-sm">
            Sign out
          </button>
        </form>
      </header>

      <aside
        id="app-sidebar"
        className={`${
          open ? "block" : "hidden"
        } lg:block lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 border-r p-4 overflow-y-auto`}
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="hidden lg:flex items-center gap-2.5 mb-5 px-1">
          <div
            className="h-9 w-9 rounded-lg bg-brand-600 text-white grid place-items-center font-bold"
            style={{ letterSpacing: "-0.04em" }}
          >
            F
          </div>
          <div>
            <p className="font-bold leading-tight tracking-tight">Faccep</p>
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
