"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import {
  ACTION_LABELS,
  PERMISSION_ACTIONS,
  groupModules,
  type ModuleRow,
  type PermissionAction,
} from "@/lib/permissions";

import type { ActionState } from "../actions";

/** null = inherit from the role. */
export type OverrideCell = boolean | null;
export type OverrideState = Record<string, Record<PermissionAction, OverrideCell>>;
export type RoleBaseline = Record<string, Record<PermissionAction, boolean>>;

function supports(mod: ModuleRow, action: PermissionAction) {
  if (action === "approve") return mod.supports_approve;
  if (action === "void") return mod.supports_void;
  return true;
}

/** inherit -> allow -> deny -> inherit */
function nextValue(current: OverrideCell): OverrideCell {
  if (current === null) return true;
  if (current === true) return false;
  return null;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Save overrides"}
    </button>
  );
}

export function OverrideMatrix({
  companyUserId,
  modules,
  initial,
  roleBaseline,
  roleName,
  canEdit,
  action,
}: {
  companyUserId: string;
  modules: ModuleRow[];
  initial: OverrideState;
  roleBaseline: RoleBaseline;
  roleName: string;
  canEdit: boolean;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [overrides, setOverrides] = useState<OverrideState>(initial);
  const groups = groupModules(modules);

  const overrideCount = Object.values(overrides).reduce(
    (total, row) =>
      total + Object.values(row).filter((value) => value !== null).length,
    0,
  );

  function cycle(moduleKey: string, permissionAction: PermissionAction) {
    setOverrides((current) => ({
      ...current,
      [moduleKey]: {
        ...current[moduleKey],
        [permissionAction]: nextValue(current[moduleKey]?.[permissionAction] ?? null),
      },
    }));
  }

  function clearAll() {
    setOverrides((current) => {
      const next: OverrideState = {};
      for (const key of Object.keys(current)) {
        next[key] = {
          view: null,
          edit: null,
          delete: null,
          approve: null,
          void: null,
        };
      }
      return next;
    });
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="companyUserId" value={companyUserId} />

      <div className="card mb-4">
        <div className="card-body flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm">
            <p>
              Cells follow <strong>{roleName}</strong> unless you override them.
              Click a cell to cycle{" "}
              <span className="badge">inherit</span> →{" "}
              <span className="badge" style={{ color: "var(--success)" }}>
                allow
              </span>{" "}
              →{" "}
              <span className="badge" style={{ color: "var(--danger)" }}>
                deny
              </span>
              .
            </p>
            <p className="muted text-xs mt-1">
              {overrideCount} override{overrideCount === 1 ? "" : "s"} set.
            </p>
          </div>
          {canEdit ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll}>
              Clear all overrides
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {groups.map(({ group, items }) => (
          <section key={group} className="card">
            <div className="card-header">
              <h3 className="font-semibold text-sm">{group}</h3>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ minWidth: "14rem" }}>Module</th>
                    {PERMISSION_ACTIONS.map((permissionAction) => (
                      <th key={permissionAction} className="text-center">
                        {ACTION_LABELS[permissionAction]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((mod) => (
                    <tr key={mod.key}>
                      <td>
                        <p className="font-medium">{mod.label}</p>
                      </td>
                      {PERMISSION_ACTIONS.map((permissionAction) => {
                        if (!supports(mod, permissionAction)) {
                          return (
                            <td key={permissionAction} className="text-center">
                              <span className="muted text-xs">—</span>
                            </td>
                          );
                        }

                        const override =
                          overrides[mod.key]?.[permissionAction] ?? null;
                        const inherited =
                          roleBaseline[mod.key]?.[permissionAction] ?? false;
                        const effective = override ?? inherited;

                        const label =
                          override === null
                            ? inherited
                              ? "Yes"
                              : "No"
                            : override
                              ? "Allow"
                              : "Deny";

                        return (
                          <td key={permissionAction} className="text-center">
                            {override !== null ? (
                              <input
                                type="hidden"
                                name={`${mod.key}|${permissionAction}`}
                                value={String(override)}
                              />
                            ) : null}
                            <button
                              type="button"
                              disabled={!canEdit}
                              onClick={() => cycle(mod.key, permissionAction)}
                              className="badge"
                              aria-label={`${ACTION_LABELS[permissionAction]} ${mod.label}: ${label}`}
                              style={{
                                minWidth: "3.5rem",
                                justifyContent: "center",
                                cursor: canEdit ? "pointer" : "default",
                                opacity: override === null ? 0.6 : 1,
                                borderStyle: override === null ? "dashed" : "solid",
                                color:
                                  override === null
                                    ? "var(--text-muted)"
                                    : effective
                                      ? "var(--success)"
                                      : "var(--danger)",
                              }}
                            >
                              {label}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      {canEdit ? (
        <div
          className="sticky bottom-0 mt-5 py-3 flex items-center gap-3 flex-wrap border-t"
          style={{ background: "var(--canvas)", borderColor: "var(--border)" }}
        >
          <SaveButton />
          <FormError message={state.error} />
          {state.success ? (
            <p className="text-sm" style={{ color: "var(--success)" }}>
              {state.success}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
