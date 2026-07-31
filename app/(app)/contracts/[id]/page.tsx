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
  deleteContract,
  recordSignedCopy,
  terminateContract,
  updateContract,
} from "../actions";
import { CONTRACT_STATUS_BADGE } from "../constants";
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
       contract_inclusions(inclusion, label, amount)`,
    )
    .eq("id", id)
    .maybeSingle<ContractDetail>();

  if (!contract || contract.company_id !== companyId) notFound();

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
              Monthly rent
            </p>
            <p
              className="text-2xl font-bold mt-1 tabular-nums"
              style={{ color: "var(--color-gold-500)" }}
            >
              {money(contract.monthly_rent)}
            </p>
            <p className="text-xs muted mt-1">
              Due day {contract.rent_due_day} · {Number(contract.escalation_rate)}%
              escalation
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <p className="text-[0.7rem] font-bold uppercase tracking-[0.06em] muted">
              Deposit / advance
            </p>
            <p className="text-lg font-bold mt-1 tabular-nums">
              {money(contract.security_deposit)}
            </p>
            <p className="text-xs muted">
              Advance {money(contract.advance_payment)}
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
