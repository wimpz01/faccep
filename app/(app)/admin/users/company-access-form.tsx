"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./company-access-actions";

export type CompanySeat = {
  id: string;
  name: string;
  /** Whether this person may sign in to it today. */
  allowed: boolean;
  roleId: string | null;
  /** That company's own roles: a role belongs to one company. */
  roles: { id: string; name: string }[];
  /** Whether the person viewing this page may change it. */
  canAdminister: boolean;
  isCompanyAdmin: boolean;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
      {pending ? "Saving…" : "Save access"}
    </button>
  );
}

/**
 * Which companies this person is allowed into.
 *
 * Named a matrix, not a form, to keep it apart from the CompanyAccessForm
 * that sets role and status within a single company.
 *
 * One row per company with a tick and, when ticked, that company's own roles.
 * The role has to be chosen per company because a role belongs to a company --
 * Faccep's Cashier and Company A's Cashier are different records, even where
 * they grant the same things.
 */
export function CompanyAccessMatrix({
  action,
  userId,
  seats,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  userId: string;
  seats: CompanySeat[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [rows, setRows] = useState(seats);

  const set = (id: string, patch: Partial<CompanySeat>) =>
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="user_id" value={userId} />

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>Allowed</th>
              <th>Company</th>
              <th style={{ width: "16rem" }}>Role in that company</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ opacity: row.canAdminister ? 1 : 0.55 }}>
                <td>
                  <input
                    type="checkbox"
                    name={`allow:${row.id}`}
                    aria-label={`Allowed into ${row.name}`}
                    checked={row.allowed}
                    disabled={!row.canAdminister}
                    onChange={(event) =>
                      set(row.id, { allowed: event.currentTarget.checked })
                    }
                    className="h-4 w-4 accent-[var(--color-brand-600)]"
                  />
                </td>
                <td className="text-sm">
                  {row.name}
                  {row.isCompanyAdmin ? (
                    <span className="block text-xs muted">
                      Company admin here — full access whatever the role says.
                    </span>
                  ) : null}
                  {row.canAdminister ? null : (
                    <span className="block text-xs muted">
                      You do not administer this company.
                    </span>
                  )}
                </td>
                <td>
                  <select
                    name={`role:${row.id}`}
                    className="select"
                    value={row.roleId ?? ""}
                    disabled={!row.canAdminister || !row.allowed}
                    onChange={(event) =>
                      set(row.id, { roleId: event.currentTarget.value || null })
                    }
                  >
                    <option value="">No role — no access until assigned</option>
                    {row.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit />
        <span className="text-xs muted">
          Unticking stops them signing in but keeps their role and overrides,
          so turning it back on restores what they had.
        </span>
        <FormError message={state.error} />
        {state.success ? (
          <p className="text-sm" style={{ color: "var(--success)" }}>
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
