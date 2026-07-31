"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./actions";

export type RoleOption = { id: string; name: string };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

function Result({ state }: { state: ActionState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.success ? (
        <p className="text-sm" style={{ color: "var(--success)" }}>
          {state.success}
        </p>
      ) : null}
    </>
  );
}

export function NewUserForm({
  action,
  roles,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  roles: RoleOption[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="new-user-name">
          Full name *
        </label>
        <input id="new-user-name" name="full_name" className="input" required />
      </div>

      <div>
        <label className="label" htmlFor="new-user-email">
          Email *
        </label>
        <input
          id="new-user-email"
          name="email"
          type="email"
          className="input"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="new-user-password">
          Initial password *
        </label>
        <input
          id="new-user-password"
          name="password"
          type="text"
          className="input"
          minLength={10}
          required
          placeholder="At least 10 characters"
        />
        <p className="text-xs muted mt-1">
          There is no email delivery — hand this to the user directly and have
          them change it.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="new-user-role">
          Role
        </label>
        <select id="new-user-role" name="role_id" className="select" defaultValue="">
          <option value="">No role — no access until assigned</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>

      <div className="sm:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_company_admin"
            className="h-4 w-4 accent-[var(--color-brand-600)]"
          />
          Company admin — full access to everything in this company, including
          users and roles
        </label>
      </div>

      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label="Create user" />
        <Result state={state} />
      </div>
    </form>
  );
}

export function CompanyAccessForm({
  action,
  companyUserId,
  roles,
  roleId,
  isCompanyAdmin,
  isActive,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  companyUserId: string;
  roles: RoleOption[];
  roleId: string | null;
  isCompanyAdmin: boolean;
  isActive: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="companyUserId" value={companyUserId} />

      <div>
        <label className="label" htmlFor={`role-${companyUserId}`}>
          Role
        </label>
        <select
          id={`role-${companyUserId}`}
          name="role_id"
          className="select"
          defaultValue={roleId ?? ""}
        >
          <option value="">No role</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col justify-end gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_company_admin"
            defaultChecked={isCompanyAdmin}
            className="h-4 w-4 accent-[var(--color-brand-600)]"
          />
          Company admin
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="is_active"
            defaultChecked={isActive}
            className="h-4 w-4 accent-[var(--color-brand-600)]"
          />
          Access active
        </label>
      </div>

      <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
        <Submit label="Save access" />
        <Result state={state} />
      </div>
    </form>
  );
}
