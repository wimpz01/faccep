import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div
            className="h-11 w-11 rounded-xl bg-brand-600 text-white grid place-items-center text-xl font-bold"
            style={{ letterSpacing: "-0.04em" }}
          >
            NR
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Night Rider</h1>
            <p className="text-xs muted">Property Management System</p>
          </div>
        </div>

        <div className="card">
          <div className="card-body">
            <LoginForm next={next} />
          </div>
        </div>

        <p className="text-xs muted mt-4 text-center">
          Sign in with the user code your administrator gave you. Three wrong
          attempts will lock the account.
        </p>
      </div>
    </main>
  );
}
