"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";

import type { ActionState } from "./copy-actions";

const GROUPS = [
  {
    value: "print",
    label: "Billing print layout",
    hint: "Page size, margins, type size, which columns and blocks appear, and the logo. The logo file is copied, not shared, so each company owns its own.",
  },
  {
    value: "tax",
    label: "Tax rates and VAT",
    hint: "The VAT rate and the four BIR withholding rates. Only affects documents raised afterwards.",
  },
  {
    value: "roles",
    label: "Roles and permissions",
    hint: "Every role and what it may do. A role of the same name is updated in place; a role only the other company has is left alone. Its grants are replaced, so a permission withdrawn here is withdrawn there.",
  },
  {
    value: "lists",
    label: "Reference lists",
    hint: "Payment terms, inventory categories and non-stock items. Added where missing, matched by name — anything already there keeps its own wording.",
  },
] as const;

function Submit({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-sm"
      disabled={pending || count === 0}
    >
      {pending
        ? "Copying…"
        : count === 0
          ? "Choose a company"
          : `Copy to ${count} company${count === 1 ? "" : "s"}`}
    </button>
  );
}

/**
 * Pushes this company's settings onto the others.
 *
 * Both lists are ticked rather than chosen from a dropdown: copying is usually
 * "these three things to those two companies", and a pair of dropdowns would
 * make that several trips.
 */
export function CopySettingsForm({
  action,
  sourceName,
  companies,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  sourceName: string;
  companies: { id: string; name: string; canAdminister: boolean }[];
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [targets, setTargets] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>(["print", "tax", "lists"]);

  const toggle = (
    list: string[],
    set: (next: string[]) => void,
    value: string,
  ) =>
    set(
      list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value],
    );

  const reachable = companies.filter((row) => row.canAdminister);

  if (companies.length === 0) {
    return (
      <p className="text-sm muted">
        There is no other company to copy to. Settings apply to{" "}
        <strong>{sourceName}</strong> alone.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div>
        <p className="label">What to copy from {sourceName}</p>
        <div className="flex flex-col gap-3 mt-1">
          {GROUPS.map((group) => (
            <label
              key={group.value}
              className="flex items-start gap-2 text-sm"
              style={{ cursor: "pointer" }}
            >
              <input
                type="checkbox"
                name="group"
                value={group.value}
                checked={groups.includes(group.value)}
                onChange={() => toggle(groups, setGroups, group.value)}
                className="h-4 w-4 accent-[var(--color-brand-600)]"
                style={{ marginTop: "0.2rem" }}
              />
              <span>
                {group.label}
                <span className="block text-xs muted">{group.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="label">Which companies to copy to</p>
        <div className="flex flex-col gap-2 mt-1">
          {companies.map((row) => (
            <label
              key={row.id}
              className="flex items-start gap-2 text-sm"
              style={{
                cursor: row.canAdminister ? "pointer" : "not-allowed",
                opacity: row.canAdminister ? 1 : 0.55,
              }}
            >
              <input
                type="checkbox"
                name="target"
                value={row.id}
                disabled={!row.canAdminister}
                checked={targets.includes(row.id)}
                onChange={() => toggle(targets, setTargets, row.id)}
                className="h-4 w-4 accent-[var(--color-brand-600)]"
                style={{ marginTop: "0.2rem" }}
              />
              <span>
                {row.name}
                {row.canAdminister ? null : (
                  <span className="block text-xs muted">
                    You do not administer this company, so its settings cannot
                    be changed from here.
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
        {reachable.length === 0 ? (
          <p className="text-xs muted mt-2">
            None of the other companies are yours to administer.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Submit count={targets.length} />
        <span className="text-xs muted">
          Nothing is deleted. Settings are added or brought into line, never
          removed.
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
