import type { Metadata } from "next";

import { signOut } from "@/app/login/actions";
import { requireSession } from "@/lib/auth";

export const metadata: Metadata = { title: "No company" };

export default async function NoCompanyPage() {
  const context = await requireSession();

  return (
    <main className="min-h-screen grid place-items-center px-4 py-12">
      <div className="card max-w-md w-full">
        <div className="card-body text-center">
          <h1 className="text-lg font-bold mb-1">No company assigned</h1>
          <p className="text-sm muted">
            {context.isSuperAdmin
              ? "No company exists yet. Create the first one with the bootstrap script in supabase/seed/, then reload."
              : "Your account is not attached to any company yet. Ask an administrator to give you access."}
          </p>
          <form action={signOut} className="mt-5">
            <button type="submit" className="btn btn-secondary">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
