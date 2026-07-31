"use client";

import { useState } from "react";

import { money } from "@/lib/format";

export type ProposalData = {
  inquiryNo: string;
  prospect: {
    contactPerson: string;
    companyName: string | null;
    email: string | null;
    mobile: string | null;
  };
  company: {
    name: string;
    address: string | null;
    contactNumber: string | null;
    email: string | null;
  };
  unit: {
    code: string;
    areaSqm: string | null;
    description: string | null;
    appliances: string[];
    locationName: string;
    locationAddress: string | null;
  } | null;
  rent: number;
  termYears: number;
  schedule: { year: number; rent: number }[];
  requirement: string | null;
};

/** Editable clause, per spec 15: proposals allow edits before finalising. */
function Editable({ children }: { children: React.ReactNode }) {
  return (
    <p className="doc-editable" contentEditable suppressContentEditableWarning>
      {children}
    </p>
  );
}

export function ProposalView({ data }: { data: ProposalData }) {
  const [showGuides, setShowGuides] = useState(true);
  const today = new Date().toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <>
      <div className="no-print flex items-center gap-2 flex-wrap mb-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.print()}
        >
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
          Dashed paragraphs are editable — adjust the wording, then print. Edits
          affect this printout only.
        </p>
      </div>

      <article className="doc-sheet card" data-guides={showGuides ? "on" : "off"}>
        <div style={{ marginBottom: "1.5rem" }}>
          <p style={{ fontWeight: 700, fontSize: "1.05rem", margin: 0 }}>
            {data.company.name}
          </p>
          <p style={{ margin: 0, fontSize: "0.8rem" }}>
            {data.company.address ?? ""}
          </p>
          <p style={{ margin: 0, fontSize: "0.8rem" }}>
            {[data.company.contactNumber, data.company.email]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <p style={{ textAlign: "right", fontSize: "0.85rem" }}>{today}</p>

        <p style={{ marginBottom: "0.2rem" }}>
          <strong>{data.prospect.contactPerson}</strong>
        </p>
        {data.prospect.companyName ? (
          <p style={{ margin: 0 }}>{data.prospect.companyName}</p>
        ) : null}
        <p style={{ fontSize: "0.85rem", marginTop: 0 }}>
          {[data.prospect.mobile, data.prospect.email].filter(Boolean).join(" · ")}
        </p>

        <h1 style={{ marginTop: "1.5rem" }}>Leasing Proposal</h1>
        <p style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          Reference {data.inquiryNo}
        </p>

        <Editable>
          Thank you for your interest in our property. We are pleased to set out
          below our proposal for the space you enquired about, and we would be
          glad to arrange a viewing at your convenience.
        </Editable>

        {data.unit ? (
          <>
            <h2>The space</h2>
            <table>
              <tbody>
                <tr>
                  <th style={{ width: "35%" }}>Location</th>
                  <td>
                    {data.unit.locationName}
                    {data.unit.locationAddress
                      ? ` — ${data.unit.locationAddress}`
                      : ""}
                  </td>
                </tr>
                <tr>
                  <th>Unit</th>
                  <td>{data.unit.code}</td>
                </tr>
                <tr>
                  <th>Floor area</th>
                  <td>
                    {data.unit.areaSqm
                      ? `${Number(data.unit.areaSqm)} square metres`
                      : "To be confirmed"}
                  </td>
                </tr>
                {data.unit.appliances.length > 0 ? (
                  <tr>
                    <th>Included</th>
                    <td>{data.unit.appliances.join(", ")}</td>
                  </tr>
                ) : null}
                {data.unit.description ? (
                  <tr>
                    <th>Description</th>
                    <td>{data.unit.description}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </>
        ) : (
          <Editable>
            We have several units that may suit your requirement, and would be
            happy to walk you through the options.
          </Editable>
        )}

        <h2>Commercial terms</h2>
        <table>
          <tbody>
            <tr>
              <th style={{ width: "35%" }}>Monthly rent</th>
              <td>
                <strong>{money(data.rent)}</strong>
              </td>
            </tr>
            <tr>
              <th>Lease term</th>
              <td>
                {data.termYears} year{data.termYears === 1 ? "" : "s"}
              </td>
            </tr>
            <tr>
              <th>Security deposit</th>
              <td>{money(data.rent * 2)} (two months)</td>
            </tr>
            <tr>
              <th>Advance rental</th>
              <td>{money(data.rent)} (one month)</td>
            </tr>
            <tr>
              <th>Utilities</th>
              <td>
                Water and electricity are sub-metered and billed at cost, based on
                the provider&apos;s rate for the period.
              </td>
            </tr>
          </tbody>
        </table>

        {data.schedule.length > 1 ? (
          <>
            <h2>Indicative rent over the term</h2>
            <Editable>
              The figures below assume a 5% annual escalation. The final rate is
              agreed before signing and is fixed in the contract.
            </Editable>
            <table>
              <thead>
                <tr>
                  <th>Year</th>
                  <th style={{ textAlign: "right" }}>Monthly rent</th>
                </tr>
              </thead>
              <tbody>
                {data.schedule.map((row) => (
                  <tr key={row.year}>
                    <td>Year {row.year}</td>
                    <td style={{ textAlign: "right" }}>{money(row.rent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <h2>Next steps</h2>
        <Editable>
          This proposal is indicative and open for thirty (30) days. On your
          confirmation we will prepare the contract of lease for signing, at which
          point the security deposit and advance rental fall due.
        </Editable>

        <div style={{ marginTop: "2.5rem" }}>
          <p style={{ marginBottom: "2.5rem" }}>Yours sincerely,</p>
          <p style={{ margin: 0 }}>______________________________</p>
          <p style={{ margin: 0 }}>
            <strong>{data.company.name}</strong>
          </p>
        </div>
      </article>

      <style>{`
        [data-guides="off"] .doc-editable { outline: none; }
      `}</style>
    </>
  );
}
