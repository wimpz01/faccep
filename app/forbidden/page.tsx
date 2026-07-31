import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "No access" };

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>;
}) {
  const { module } = await searchParams;

  return (
    <main className="min-h-screen grid place-items-center px-4 py-12">
      <div className="card max-w-md w-full">
        <div className="card-body text-center">
          <h1 className="text-lg font-bold mb-1">You don&apos;t have access</h1>
          <p className="text-sm muted">
            Your role does not include permission for
            {module ? (
              <>
                {" "}
                <span className="badge">{module}</span>
              </>
            ) : (
              " this page"
            )}
            . Ask an administrator to grant it.
          </p>
          <Link href="/dashboard" className="btn btn-secondary mt-5">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
