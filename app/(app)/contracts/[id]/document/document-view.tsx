"use client";

import { useState } from "react";

import { escalatedAmount, formatDateLong, money } from "@/lib/format";

export type DocumentData = {
  contractNo: string;
  status: string;
  company: {
    name: string;
    legalName: string | null;
    address: string | null;
    tin: string | null;
  };
  tenant: {
    companyName: string;
    address: string | null;
    contactPerson: string | null;
    tin: string | null;
    isVatable: boolean;
  };
  units: { code: string; locationName: string; areaSqm: string | null }[];
  inclusions: { inclusion: string; label: string | null; amount: string | null }[];
  startDate: string;
  endDate: string;
  termYears: number;
  monthlyRent: number;
  securityDeposit: number;
  advancePayment: number;
  escalationRate: number;
  rentDueDay: number;
  penaltyRate: number;
  waterBillingType: string;
  waterFixedAmount: number | null;
  waterMinimumAmount: number | null;
  electricBillingType: string;
  electricFixedAmount: number | null;
  electricMinimumAmount: number | null;
  repairResponsibility: string | null;
  renewalTerms: string | null;
  terminationGrounds: string | null;
};

const VAT_RATE = 0.12;

const INCLUSION_LABELS: Record<string, string> = {
  rent: "Monthly rent",
  parking: "Parking",
  security_guard: "Security guard",
  water: "Water",
  electricity: "Electricity",
  other: "Other",
};

function utilityClause(
  utility: string,
  type: string,
  fixed: number | null,
  minimum: number | null,
) {
  if (type === "fixed") {
    return `${utility} is billed at a fixed rate of ${money(fixed)} per month regardless of consumption.`;
  }
  if (type === "minimum_overage") {
    return `${utility} is billed at a minimum of ${money(minimum)} per month; consumption beyond that minimum is billed at the prevailing rate derived from the provider's bill for the period.`;
  }
  return `${utility} is billed purely on consumption, computed as the difference between the present and previous sub-meter readings multiplied by the rate derived from the provider's bill for the period.`;
}

/** A clause the user may reword before printing (spec 4.2). */
function Editable({
  children,
  as: Tag = "p",
}: {
  children: React.ReactNode;
  as?: "p" | "span";
}) {
  return (
    <Tag className="doc-editable" contentEditable suppressContentEditableWarning>
      {children}
    </Tag>
  );
}

export function DocumentView({ data }: { data: DocumentData }) {
  const [showGuides, setShowGuides] = useState(true);

  const vat = data.tenant.isVatable ? data.monthlyRent * VAT_RATE : 0;
  const schedule = Array.from({ length: Math.min(data.termYears, 10) }, (_, i) => ({
    year: i + 1,
    rent: escalatedAmount(data.monthlyRent, data.escalationRate, i),
    deposit: escalatedAmount(data.securityDeposit, data.escalationRate, i),
  }));

  return (
    <>
      <div className="no-print flex items-center gap-2 flex-wrap mb-4">
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowGuides((value) => !value)}
        >
          {showGuides ? "Hide edit guides" : "Show edit guides"}
        </button>
        <p className="text-xs muted">
          Dashed clauses are editable — reword them here, then print. Edits are for
          this printout only and are not saved to the record.
        </p>
      </div>

      {data.status === "draft" ? (
        <div className="no-print card mb-4">
          <div className="card-body">
            <p className="text-sm">
              This contract is still a <strong>draft</strong>. Activate it once the
              signed copy is back.
            </p>
          </div>
        </div>
      ) : null}

      <article className="doc-sheet card" data-guides={showGuides ? "on" : "off"}>
        <h1>Contract of Lease</h1>
        <p style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          No. {data.contractNo}
        </p>

        <p>
          This Contract of Lease is entered into by and between{" "}
          <strong>{data.company.legalName ?? data.company.name}</strong>
          {data.company.address ? `, with address at ${data.company.address}` : ""}
          {data.company.tin ? `, TIN ${data.company.tin}` : ""} (the{" "}
          <strong>LESSOR</strong>), and{" "}
          <strong>{data.tenant.companyName}</strong>
          {data.tenant.address ? `, with address at ${data.tenant.address}` : ""}
          {data.tenant.tin ? `, TIN ${data.tenant.tin}` : ""}
          {data.tenant.contactPerson
            ? `, represented by ${data.tenant.contactPerson}`
            : ""}{" "}
          (the <strong>LESSEE</strong>).
        </p>

        <h2>1. Leased Premises</h2>
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Location</th>
              <th>Area (sqm)</th>
            </tr>
          </thead>
          <tbody>
            {data.units.map((unit) => (
              <tr key={`${unit.locationName}-${unit.code}`}>
                <td>{unit.code}</td>
                <td>{unit.locationName}</td>
                <td>{unit.areaSqm ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>2. Lease Period</h2>
        <p>
          The lease shall run for <strong>{data.termYears}</strong> year
          {data.termYears === 1 ? "" : "s"}, commencing{" "}
          <strong>{formatDateLong(data.startDate)}</strong> and expiring{" "}
          <strong>{formatDateLong(data.endDate)}</strong>.
        </p>

        <h2>3. Rent, Deposit and Advance</h2>
        <table>
          <tbody>
            <tr>
              <th style={{ width: "45%" }}>Monthly rent</th>
              <td>{money(data.monthlyRent)}</td>
            </tr>
            {data.tenant.isVatable ? (
              <>
                <tr>
                  <th>Add: VAT (12%)</th>
                  <td>{money(vat)}</td>
                </tr>
                <tr>
                  <th>Monthly rent inclusive of VAT</th>
                  <td>
                    <strong>{money(data.monthlyRent + vat)}</strong>
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <th>VAT</th>
                <td>Not applicable — the LESSEE is non-VAT registered.</td>
              </tr>
            )}
            <tr>
              <th>Security deposit</th>
              <td>{money(data.securityDeposit)}</td>
            </tr>
            <tr>
              <th>Advance payment</th>
              <td>{money(data.advancePayment)}</td>
            </tr>
            <tr>
              <th>Rent due date</th>
              <td>Day {data.rentDueDay} of each month</td>
            </tr>
          </tbody>
        </table>

        <h2>4. Annual Escalation</h2>
        {data.escalationRate === 0 ? (
          <Editable>
            No escalation shall be applied. The monthly rent and security deposit
            remain fixed for the whole of the lease period.
          </Editable>
        ) : (
          <>
            <Editable>
              The monthly rent and the security deposit shall each increase by{" "}
              <strong>{data.escalationRate}%</strong> on every anniversary of the
              commencement date, applied to the immediately preceding year&apos;s
              amount.
            </Editable>
            <table>
              <thead>
                <tr>
                  <th>Contract year</th>
                  <th>Monthly rent</th>
                  <th>Security deposit</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.year}>
                    <td>Year {row.year}</td>
                    <td>{money(row.rent)}</td>
                    <td>{money(row.deposit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h2>5. Items Included in the Billing</h2>
        {data.inclusions.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.inclusions.map((item, index) => (
                <tr key={`${item.inclusion}-${index}`}>
                  <td>
                    {item.label ?? INCLUSION_LABELS[item.inclusion] ?? item.inclusion}
                  </td>
                  <td>{item.amount ? money(item.amount) : "As billed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Editable>
            The monthly billing covers rent only. No other charges form part of the
            regular billing.
          </Editable>
        )}

        <h2>6. Water and Electricity</h2>
        <Editable>
          {utilityClause(
            "Water",
            data.waterBillingType,
            data.waterFixedAmount,
            data.waterMinimumAmount,
          )}
        </Editable>
        <Editable>
          {utilityClause(
            "Electricity",
            data.electricBillingType,
            data.electricFixedAmount,
            data.electricMinimumAmount,
          )}{" "}
          Where a generator is used, the LESSEE shall additionally bear a share of
          the generator expense for the period, pro-rated by the LESSEE&apos;s
          kilowatt-hour consumption against total building consumption.
        </Editable>

        <h2>7. Late Payment</h2>
        <Editable>
          A penalty of <strong>{data.penaltyRate}%</strong> shall be charged on any
          water or electricity billing that remains unpaid more than one (1) week
          after the LESSEE receives it.
        </Editable>

        <h2>8. Repairs and Maintenance</h2>
        <Editable>
          {data.repairResponsibility ??
            "The LESSEE shall maintain the leased premises in good condition and shall bear the cost of repairs arising from its own use. Structural repairs remain the responsibility of the LESSOR."}
        </Editable>

        <h2>9. Renewal</h2>
        <Editable>
          {data.renewalTerms ??
            "This lease may be renewed upon mutual written agreement of the parties. The LESSEE shall give written notice of intent to renew not later than sixty (60) days before expiry."}
        </Editable>

        <h2>10. Termination</h2>
        <Editable>
          {data.terminationGrounds ??
            "The LESSOR may terminate this lease for non-payment of rent or utilities for two (2) consecutive months, for breach of any provision of this contract, or for use of the premises contrary to law. Abandonment of the premises without notice shall entitle the LESSOR to treat items left behind as forfeited."}
        </Editable>

        <h2>11. Security Deposit Refund</h2>
        <Editable>
          The security deposit shall be refunded within thirty (30) days from the end
          of the lease, after inspection of the premises and after deduction of any
          unpaid bills and the cost of repairing damage beyond ordinary wear and
          tear.
        </Editable>

        <div style={{ marginTop: "2.5rem" }}>
          <table style={{ border: "none" }}>
            <tbody>
              <tr>
                <td style={{ border: "none", width: "50%", paddingTop: "2.5rem" }}>
                  ______________________________
                  <br />
                  <strong>{data.company.legalName ?? data.company.name}</strong>
                  <br />
                  LESSOR
                </td>
                <td style={{ border: "none", width: "50%", paddingTop: "2.5rem" }}>
                  ______________________________
                  <br />
                  <strong>{data.tenant.companyName}</strong>
                  <br />
                  LESSEE
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <style>{`
        [data-guides="off"] .doc-editable { outline: none; }
      `}</style>
    </>
  );
}
