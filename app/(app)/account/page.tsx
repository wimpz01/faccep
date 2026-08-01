import type { Metadata } from "next";

import { Card, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth";

import { changeOwnPassword } from "./actions";
import { ChangePasswordForm } from "./password-form";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const context = await requireSession();

  return (
    <>
      <PageHeader
        title="My account"
        description="Your sign-in details and where you have access."
      />

      <div className="mb-6">
        <Card
          title="Change password"
          description="Your current password is required, so an unattended session is not enough to take the account over."
        >
          <ChangePasswordForm action={changeOwnPassword} />
        </Card>
      </div>

      <Card title="Your access" bodyClassName="">
        <div className="table-scroll">
          <table className="table">
            <tbody>
              <tr>
                <th style={{ width: "14rem" }}>User code</th>
                <td>
                  <strong className="tabular-nums">{context.userCode}</strong>
                  <p className="text-xs muted">This is what you sign in with.</p>
                </td>
              </tr>
              <tr>
                <th>Signed in as</th>
                <td>
                  {context.fullName}
                  <p className="text-xs muted break-all">{context.email}</p>
                </td>
              </tr>
              <tr>
                <th>Account type</th>
                <td>
                  {context.isSuperAdmin ? (
                    <>
                      <span className="badge badge-brand">Super admin</span>
                      <p className="text-xs muted mt-1">
                        Bypasses every permission check in every company.
                      </p>
                    </>
                  ) : (
                    <span className="badge">Standard user</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>Companies</th>
                <td>
                  {context.memberships.length > 0 ? (
                    <ul className="text-sm flex flex-col gap-1">
                      {context.memberships.map((membership) => (
                        <li key={membership.companyId}>
                          {membership.companyName}
                          <span className="text-xs muted">
                            {" — "}
                            {membership.isCompanyAdmin
                              ? "company admin"
                              : (membership.roleName ?? "no role")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm muted">None</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
