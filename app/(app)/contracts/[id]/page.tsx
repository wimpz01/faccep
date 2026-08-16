import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { requirePermission } from "@/lib/auth";
import { formatDate, money } from "@/lib/format";
import { MODULE, can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

import {
  activateContract,
  decideEscalation,
  deleteContract,
  recordSignedCopy,
  terminateContract,
  updateContract,
} from "../actions";
import { CONTRACT_STATUS_BADGE, FUND_STATUS } from "../constants";
import { EscalationDecisionForm } from "../escalation-form";
import { ContractForm } from "../contract-form";
import { loadContractOptions } from "../data";
import { ActivateForm, SignedCopyUploader, TerminateForm } from "./lifecycle";

export const metadata: Metadata = { title: "Contract" };

type ContractDetail = {
  id: string;
  company_id: string;
  tenant_id: string;
  contract_no: string;
  status: string;
  start_date: string;
  end_date: string;
  term_years: number;
  monthly_rent: string;
  security_deposit: string;
  advance_payment: string;
  escalation_rate: string;
  rent_due_day: number;
  penalty_rate: string;
  water_billing_type: string;
  water_fixed_amount: string | null;
  water_minimum_amount: string | null;
  electric_billing_type: string;
  electric_fixed_amount: string | null;
  electric_minimum_amount: string | null;
  repair_responsibility: string | null;
  renewal_terms: string | null;
  termination_grounds: string | null;
  notes: string | null;
  signed_document_path: string | null;
  signed_at: string | null;
  terminated_at: string | null;
  termination_reason: string | null;
  tenants: { company_name: string } | null;
  contract_units: { unit_id: string; units: { code: string } | null }[];
  contract_inclusions: {
    inclusion: string;
    label: string | null;
    amount: string | null;
    tax_treatment: string | null;
    vat_mode: string | null;
  }[];
};

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.contracts, "view");
  const companyId = context.activeCompany!.companyId;
  const canEdit = can(context.permissions, MODULE.contracts, "edit");
  const canApprove = can(context.permissions, MODULE.contracts, "approve");
  const canDelete = can(context.permissions, MODULE.contracts, "delete");

  const supabase = await createClient();
  const { data: contract } = await supabase
    .from("contracts")
    .select(
      `*, tenants(company_name),
       contract_units(unit_id, units(code)),
       contract_inclusions(inclusion, label, amount, tax_treatment, vat_mode)`,
    )
    .eq("id", id)
    .maybeSingle<ContractDetail>();

  if (!contract || contract.company_id !== companyId) notFound();

  /*
   * The rent for every year of the term, and what remains of the money taken
   * at signing. The schedule is computed from base rent, rate and start date
   * -- the same inputs, by the same function, that billing charges from -- so
   * it can never quote a figure an invoice would not.
   */
  const today = new Date().toISOString().slice(0, 10);

  const { data: escalations } = await supabase
    .from("contract_escalations")
    .select("id, effective_date, decision, rate_percent, reason")
    .eq("contract_id", id)
    .order("effective_date")
    .returns<
      {
        id: string;
        effective_date: string;
        decision: string;
        rate_percent: string;
        reason: string | null;
      }[]
    >();

  // Rent is asked of the database at each step, because only it knows which
  // rises were held. Working it out here would risk quoting a figure no
  // invoice would ever charge.
  const steps = await Promise.all(
    [
      { date: contract.start_date, escalation: null as (typeof escalations extends (infer T)[] | null ? T : never) | null },
      ...(escalations ?? []).map((row) => ({ date: row.effective_date, escalation: row })),
    ].map(async (step) => {
      const { data } = await supabase.rpc("contract_rent_on", {
        p_contract: id,
        p_on: step.date,
      });
      return { ...step, rent: Number(data ?? 0) };
    }),
  );

  const { data: rentNow } = await supabase.rpc("contract_rent_on", {
    p_contract: id,
    p_on: today,
  });
  const currentRent = Number(rentNow ?? contract.monthly_rent);

  const { data: funds } = await supabase
    .from("contract_fund_status")
    .select(
      `deposit_taken, deposit_received, deposit_drawn, deposit_remaining, deposit_status,
       advance_taken, advance_drawn, advance_remaining, advance_status`,
    )
    .eq("contract_id", id)
    .maybeSingle<{
      deposit_taken: string;
      deposit_received: string;
      deposit_drawn: string;
      deposit_remaining: string;
      deposit_status: string;
      advance_taken: string;
      advance_drawn: string;
      advance_remaining: string;
      advance_status: string;
    }>();

  const { data: drawdowns } = await supabase
    .from("contract_fund_applications")
    .select("id, fund_kind, event, applied_on, amount, note")
    .eq("contract_id", id)
    .order("applied_on", { ascending: false })
    .returns<
      {
        id: string;
        fund_kind: string;
        event: string;
        applied_on: string;
        amount: string;
        note: string | null;
      }[]
    >();

  const unitIds = (contract.contract_units ?? []).map((link) => link.unit_id);
  const { tenants, units } = canEdit
    ? await loadContractOptions(companyId, unitIds)
    : { tenants: [], units: [] };

  let signedUrl: string | null = null;
  if (contract.signed_document_path) {
    const { data } = await supabase.storage
      .from("documents")
      .createSignedUrl(contract.signed_document_path, 3600);
    signedUrl = data?.signedUrl ?? null;
  }

  return (
    <>
      <PageHeader
        title={contract.contract_no}
        description={`${contract.tenants?.company_name ?? "Unknown tenant"} · ${formatDate(
          contract.start_date,
        )} – ${formatDate(contract.end_date)}`}
        action={
          <div className="flex gap-2 flex-wrap">
            <Link href="/contracts" className="btn btn-secondary btn-sm">
              Back
            </Link>
            <Link
              href={`/contracts/${contract.id}/document`}
              className="btn btn-primary btn-sm"
            >
              Contract document
            </Link>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Status
            </p>
            <p className="mt-1">
              <span className={CONTRACT_STATUS_BADGE[contract.status] ?? "badge"}>
                {contract.status}
              </span>
            </p>
            {contract.terminated_at ? (
              <p className="text-xs muted mt-1">
                Terminated {formatDate(contract.terminated_at)} —{" "}
                {contract.termination_reason}
              </p>
            ) : null}
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Current monthly rent
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(currentRent)}
            </p>
            <p className="text-xs muted mt-1">
              {currentRent !== Number(contract.monthly_rent)
                ? `From ${money(contract.monthly_rent)} · `
                : ""}
              Due day {contract.rent_due_day} ·{" "}
              {Number(contract.escalation_rate)}% escalation
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Deposit / advance
            </p>
            <p className="text-lg font-bold mt-1 tabular-nums">
              {money(funds?.deposit_remaining ?? 0)}
            </p>
            {/* Held is what was actually receipted. A deposit agreed at
                signing but never collected is money you do not have, and
                saying so is the whole point of the distinction. */}
            {funds?.deposit_status === "not_received" ? (
              <p className="text-xs" style={{ color: "var(--danger)" }}>
                {money(funds.deposit_taken)} agreed — not yet received
              </p>
            ) : (
              <p className="text-xs muted">
                of {money(funds?.deposit_received ?? 0)} received
              </p>
            )}
            <p className="text-xs muted">
              Advance {money(funds?.advance_remaining ?? contract.advance_payment)}
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Units
            </p>
            <p className="text-sm font-medium mt-1">
              {(contract.contract_units ?? [])
                .map((link) => link.units?.code)
                .filter(Boolean)
                .join(", ") || "None"}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Card
          title="Rent schedule"
          description="Worked out from the base rent, the escalation rate and the start date — the same three figures invoice generation charges from, so this is what will be billed."
          bodyClassName=""
        >
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Effective</th>
                  <th>Contract year</th>
                  <th className="text-right">Previous rent</th>
                  <th className="text-right">Escalation</th>
                  <th className="text-right">Monthly rent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {steps.map((step, index) => {
                  const applies =
                    step.date <= today &&
                    !steps.some(
                      (later) => later.date <= today && later.date > step.date,
                    );
                  const previous = index === 0 ? null : steps[index - 1].rent;
                  const held = step.escalation?.decision === "waived";
                  return (
                    <tr key={step.date}>
                      <td className="text-sm">{formatDate(step.date)}</td>
                      <td className="text-xs muted">Year {index + 1}</td>
                      <td className="text-right tabular-nums text-sm">
                        {previous === null ? "—" : money(previous)}
                      </td>
                      <td className="text-right tabular-nums text-sm">
                        {!step.escalation
                          ? "—"
                          : held
                            ? "held"
                            : `${Number(contract.escalation_rate)}%`}
                      </td>
                      <td className="text-right tabular-nums font-medium">
                        {money(step.rent)}
                      </td>
                      <td className="text-xs">
                        {step.escalation?.decision === "pending" &&
                        canApprove ? (
                          <EscalationDecisionForm
                            action={decideEscalation}
                            escalationId={step.escalation.id}
                          />
                        ) : held ? (
                          <>
                            <span className="badge">held</span>
                            {step.escalation?.reason ? (
                              <p className="muted mt-1">
                                {step.escalation.reason}
                              </p>
                            ) : null}
                          </>
                        ) : applies ? (
                          <span className="badge badge-brand">applies now</span>
                        ) : step.date > today ? (
                          <span className="muted">
                            {step.escalation?.decision === "pending"
                              ? "awaiting a decision"
                              : "upcoming"}
                          </span>
                        ) : (
                          <span className="muted">past</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <Card
          title="Deposit and advance"
          description="What was taken at signing, and what has become of it since. Applying or refunding is recorded under Billing → Payments, not here."
          bodyClassName=""
        >
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Fund</th>
                  <th className="text-right">Agreed at signing</th>
                  <th className="text-right">Received</th>
                  <th className="text-right">Drawn</th>
                  <th className="text-right">Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-sm">Security deposit</td>
                  <td className="text-right tabular-nums text-sm">
                    {money(funds?.deposit_taken ?? contract.security_deposit)}
                  </td>
                  <td
                    className="text-right tabular-nums text-sm"
                    style={
                      funds?.deposit_status === "not_received"
                        ? { color: "var(--danger)" }
                        : undefined
                    }
                  >
                    {money(funds?.deposit_received ?? 0)}
                  </td>
                  <td className="text-right tabular-nums text-sm">
                    {money(funds?.deposit_drawn ?? 0)}
                  </td>
                  <td className="text-right tabular-nums font-medium">
                    {money(funds?.deposit_remaining ?? 0)}
                  </td>
                  <td className="text-xs">
                    {FUND_STATUS[funds?.deposit_status ?? "held"] ?? "Held"}
                  </td>
                </tr>
                <tr>
                  <td className="text-sm">Advance / prepayment</td>
                  <td className="text-right tabular-nums text-sm">
                    {money(funds?.advance_taken ?? contract.advance_payment)}
                  </td>
                  <td className="text-right tabular-nums text-xs muted">—</td>
                  <td className="text-right tabular-nums text-sm">
                    {money(funds?.advance_drawn ?? 0)}
                  </td>
                  <td className="text-right tabular-nums font-medium">
                    {money(funds?.advance_remaining ?? contract.advance_payment)}
                  </td>
                  <td className="text-xs">
                    {FUND_STATUS[funds?.advance_status ?? "held"] ?? "Held"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {(drawdowns ?? []).length > 0 ? (
            <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
              <p className="label mb-2">Drawdowns</p>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Fund</th>
                      <th>What happened</th>
                      <th className="text-right">Amount</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(drawdowns ?? []).map((row) => (
                      <tr key={row.id}>
                        <td className="text-xs">{formatDate(row.applied_on)}</td>
                        <td className="text-xs">
                          {row.fund_kind === "security_deposit"
                            ? "Deposit"
                            : "Advance"}
                        </td>
                        <td className="text-xs">
                          <span className="badge">{row.event}</span>
                        </td>
                        <td className="text-right tabular-nums text-sm">
                          {money(row.amount)}
                        </td>
                        <td className="text-xs muted">{row.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

        </Card>
      </div>

      {canApprove && contract.status === "draft" ? (
        <div className="mb-6">
          <Card
            title="Activate"
            description="Commits the units and starts the billing obligation. Requires the Approve permission."
          >
            <ActivateForm action={activateContract} contractId={contract.id} />
          </Card>
        </div>
      ) : null}

      <div className="mb-6">
        <Card
          title="Signed copy"
          description="Contracts are printed, wet-signed and scanned back in — there is no e-signature."
        >
          {contract.signed_document_path ? (
            <p className="text-sm mb-3">
              Signed {formatDate(contract.signed_at)} ·{" "}
              {signedUrl ? (
                <a
                  href={signedUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--color-brand-600)" }}
                >
                  Open scanned copy
                </a>
              ) : (
                <span className="muted">link unavailable</span>
              )}
            </p>
          ) : (
            <p className="text-sm muted mb-3">No scanned copy on file yet.</p>
          )}

          {canEdit ? (
            <SignedCopyUploader
              contractId={contract.id}
              companyId={companyId}
              onRecord={recordSignedCopy}
            />
          ) : null}
        </Card>
      </div>

      {canEdit ? (
        <div className="mb-6">
          <ContractForm
            action={updateContract}
            tenants={tenants}
            units={units}
            submitLabel="Save contract"
            contract={{
              ...contract,
              unitIds,
              inclusions: contract.contract_inclusions ?? [],
            }}
          />
        </div>
      ) : (
        <div className="mb-6">
          <Card title="Terms">
            <dl className="grid gap-3 sm:grid-cols-2 text-sm">
              <div>
                <dt className="label">Repair responsibility</dt>
                <dd>{contract.repair_responsibility ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Renewal terms</dt>
                <dd>{contract.renewal_terms ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Grounds for termination</dt>
                <dd>{contract.termination_grounds ?? "—"}</dd>
              </div>
              <div>
                <dt className="label">Late penalty</dt>
                <dd>{Number(contract.penalty_rate)}% on unpaid utilities</dd>
              </div>
            </dl>
          </Card>
        </div>
      )}

      {canApprove && contract.status === "active" ? (
        <div className="mb-6">
          <Card
            title="Terminate"
            description="Ends the lease early and releases the units back to the vacant pool."
          >
            <TerminateForm action={terminateContract} contractId={contract.id} />
          </Card>
        </div>
      ) : null}

      {canDelete && contract.status === "draft" ? (
        <Card
          title="Delete this draft"
          description="Only a draft can be deleted. Anything that has been live is terminated instead, so the history survives."
        >
          <form action={deleteContract}>
            <input type="hidden" name="id" value={contract.id} />
            <button type="submit" className="btn btn-danger">
              Delete draft
            </button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
