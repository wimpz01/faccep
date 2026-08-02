"use client";

/**
 * Catches anything a page throws, so a failure that is not the user's fault
 * reads as a setback rather than a crash. The commonest one is the auth
 * service being briefly unreachable, which retrying usually clears.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const unreachable = error.message.includes("Could not reach the sign-in");

  return (
    <div className="card" style={{ maxWidth: "34rem", margin: "3rem auto" }}>
      <div className="card-body">
        <h1 className="text-lg font-bold tracking-tight">
          {unreachable ? "Connection interrupted" : "Something went wrong"}
        </h1>
        <p className="text-sm muted mt-2">
          {unreachable
            ? "The sign-in service could not be reached, so this page could not confirm who you are. You are still signed in and nothing was changed."
            : "This page could not be loaded. Nothing was changed."}
        </p>

        <div className="flex gap-2 flex-wrap mt-4">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <a href="/dashboard" className="btn btn-secondary">
            Back to the dashboard
          </a>
        </div>

        {error.digest ? (
          <p className="text-xs muted mt-4">Reference {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
