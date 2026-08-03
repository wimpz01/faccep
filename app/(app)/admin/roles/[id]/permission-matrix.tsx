"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { FormError } from "@/components/ui";
import {
  ACTION_HINTS,
  ACTION_LABELS,
  PERMISSION_ACTIONS,
  groupModules,
  type ModuleRow,
  type PermissionAction,
} from "@/lib/permissions";

import type { ActionState } from "../actions";

export type MatrixState = Record<string, Record<PermissionAction, boolean>>;

function supports(mod: ModuleRow, action: PermissionAction) {
  if (action === "approve") return mod.supports_approve;
  if (action === "void") return mod.supports_void;
  return true;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Save permissions"}
    </button>
  );
}

export function PermissionMatrix({
  roleId,
  modules,
  initial,
  canEdit,
  action,
}: {
  roleId: string;
  modules: ModuleRow[];
  initial: MatrixState;
  canEdit: boolean;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const [matrix, setMatrix] = useState<MatrixState>(initial);
  const groups = groupModules(modules);

  /**
   * View, edit and delete are a ladder, so ticking a rung brings everything
   * below it and unticking one drops everything above. Approve and void sit
   * apart, but still need view.
   */
  function setOne(
    moduleKey: string,
    permissionAction: PermissionAction,
    value: boolean,
  ) {
    setMatrix((current) => {
      const row = { ...current[moduleKey] };
      row[permissionAction] = value;

      if (value) {
        if (permissionAction === "delete") {
          row.edit = true;
          row.view = true;
        }
        if (permissionAction === "edit") row.view = true;
        if (permissionAction === "approve" || permissionAction === "void") {
          row.view = true;
        }
      } else {
        if (permissionAction === "view") {
          row.edit = false;
          row.delete = false;
          row.approve = false;
          row.void = false;
        }
        if (permissionAction === "edit") row.delete = false;
      }

      return { ...current, [moduleKey]: row };
    });
  }

  /** Every right this module offers, in one click. */
  function grantAll(mod: ModuleRow) {
    setMatrix((current) => {
      const row = { ...current[mod.key] };
      for (const permissionAction of PERMISSION_ACTIONS) {
        if (!supports(mod, permissionAction)) continue;
        row[permissionAction] = true;
      }
      return { ...current, [mod.key]: row };
    });
  }

  /**
   * Takes every right on one module away at once.
   *
   * Clearing view is what actually locks the module: without it the role can
   * neither open the page nor drive an action against it. The other boxes are
   * cleared too so nothing is left looking granted.
   */
  function revokeModule(moduleKey: string) {
    setMatrix((current) => {
      const row = { ...current[moduleKey] };
      for (const permissionAction of PERMISSION_ACTIONS) {
        row[permissionAction] = false;
      }
      return { ...current, [moduleKey]: row };
    });
  }

  function setMany(mods: ModuleRow[], value: boolean, only?: PermissionAction) {
    setMatrix((current) => {
      const next = { ...current };
      for (const mod of mods) {
        const row = { ...next[mod.key] };
        for (const permissionAction of PERMISSION_ACTIONS) {
          if (only && permissionAction !== only) continue;
          if (!supports(mod, permissionAction)) continue;
          row[permissionAction] = value;
        }
        next[mod.key] = row;
      }
      return next;
    });
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="roleId" value={roleId} />

      {canEdit ? (
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMany(modules, true, "view")}
          >
            Grant view on everything
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMany(modules, false)}
          >
            Clear all
          </button>
          <p className="text-xs muted">
            Void keeps the record and reverses it, and still needs an approval
            before it takes effect.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        {groups.map(({ group, items }) => (
          <section key={group} className="card">
            <div className="card-header">
              <h3 className="font-semibold text-sm">{group}</h3>
              {canEdit ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setMany(items, true, "view")}
                  >
                    View all
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setMany(items, false)}
                  >
                    None
                  </button>
                </div>
              ) : null}
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ minWidth: "14rem" }}>Module</th>
                    {PERMISSION_ACTIONS.map((permissionAction) => (
                      <th
                        key={permissionAction}
                        title={ACTION_HINTS[permissionAction]}
                        className="text-center"
                      >
                        {ACTION_LABELS[permissionAction]}
                      </th>
                    ))}
                    {canEdit ? (
                      <th className="text-center" style={{ width: "11rem" }}>
                        Access
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((mod) => (
                    <tr key={mod.key}>
                      <td>
                        <p className="font-medium">{mod.label}</p>
                        {mod.description ? (
                          <p className="text-xs muted">{mod.description}</p>
                        ) : null}
                      </td>
                      {PERMISSION_ACTIONS.map((permissionAction) => {
                        const allowed = supports(mod, permissionAction);
                        const checked =
                          allowed && (matrix[mod.key]?.[permissionAction] ?? false);
                        return (
                          <td key={permissionAction} className="text-center">
                            {allowed ? (
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-[var(--color-brand-600)]"
                                name={`${mod.key}|${permissionAction}`}
                                checked={checked}
                                disabled={!canEdit}
                                aria-label={`${ACTION_LABELS[permissionAction]} ${mod.label}`}
                                onChange={(event) =>
                                  setOne(
                                    mod.key,
                                    permissionAction,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                            ) : (
                              <span className="muted text-xs">—</span>
                            )}
                          </td>
                        );
                      })}
                      {canEdit ? (
                        <td className="text-center">
                          <div className="inline-flex gap-1.5 flex-wrap justify-center">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => grantAll(mod)}
                              title="View, edit, delete and any sign-off this module offers"
                            >
                              Grant all
                            </button>
                            {matrix[mod.key]?.view ? (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                onClick={() => revokeModule(mod.key)}
                                title="No access at all — the module is not even visible"
                              >
                                Revoke
                              </button>
                            ) : (
                              <span
                                className="text-xs self-center"
                                style={{ color: "var(--danger)" }}
                              >
                                revoked
                              </span>
                            )}
                          </div>
                        </td>
                      ) : null}
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
