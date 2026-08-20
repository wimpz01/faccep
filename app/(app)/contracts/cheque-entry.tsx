"use client";

import { useState } from "react";

import { money } from "@/lib/format";

type Row = { bank: string; chequeNo: string; amount: string; chequeDate: string };

/**
 * Records the postdated cheques while the contract is being drafted.
 *
 * They are held in the form rather than written as they are typed, because
 * the contract they belong to does not exist yet. The server writes them once
 * it does, so abandoning the draft leaves nothing behind.
 *
 * A note, not the cashier's register: nothing here is banked, chased or
 * applied to a bill.
 */
export function ChequeEntry({ defaultAmount }: { defaultAmount: string }) {
  const [rows, setRows] = useState<Row[]>([]);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  /**
   * A new row carries on from the last: the same bank, the cheque number one
   * higher, and the date a month later. A batch handed over at signing is
   * almost always one chequebook stepping monthly, and every cell stays
   * editable for the times it is not.
   */
  function addRow() {
    // Derived from the previous state rather than the captured one: clicking
    // twelve times quickly must add twelve rows, not one.
    setRows((current) => {
      const last = current[current.length - 1];
      if (!last) {
        return [{ bank: "", chequeNo: "", amount: defaultAmount, chequeDate: "" }];
      }

      const nextNo = last.chequeNo.replace(/(\d+)(?!.*\d)/, (digits) =>
        String(Number(digits) + 1).padStart(digits.length, "0"),
      );

      let nextDate = "";
      if (last.chequeDate) {
        const [y, m, d] = last.chequeDate.split("-").map(Number);
        // Day 1-28 in practice; a shorter following month would roll over.
        const stepped = new Date(y, m, Math.min(d, 28));
        nextDate = [
          stepped.getFullYear(),
          String(stepped.getMonth() + 1).padStart(2, "0"),
          String(stepped.getDate()).padStart(2, "0"),
        ].join("-");
      }

      return [
        ...current,
        { bank: last.bank, chequeNo: nextNo, amount: last.amount, chequeDate: nextDate },
      ];
    });
  }

  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  return (
    <section className="card">
      <div className="card-header">
        <h3 className="font-semibold text-sm">Postdated cheques received</h3>
        <span className="text-xs muted">
          A note of what the tenant handed over. Not the cashier&apos;s register.
        </span>
      </div>

      <div className="card-body">
        {rows.length > 0 ? (
          <div className="table-scroll mb-3">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }} className="text-right">#</th>
                  <th style={{ minWidth: "9rem" }}>Bank</th>
                  <th style={{ minWidth: "9rem" }}>Cheque number</th>
                  <th style={{ minWidth: "9rem" }}>Cheque date</th>
                  <th className="text-right" style={{ minWidth: "8rem" }}>
                    Amount
                  </th>
                  <th style={{ width: "3rem" }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td className="text-right tabular-nums text-xs muted">
                      {index + 1}
                    </td>
                    <td>
                      <input
                        name="cheque_bank"
                        className="input"
                        required
                        placeholder="BDO"
                        value={row.bank}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          update(index, { bank: next });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        name="cheque_no"
                        className="input tabular-nums"
                        required
                        placeholder="000123456"
                        value={row.chequeNo}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          update(index, { chequeNo: next });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        name="cheque_date"
                        type="date"
                        className="input"
                        required
                        value={row.chequeDate}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          update(index, { chequeDate: next });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        name="cheque_amount"
                        type="number"
                        step="0.01"
                        min="0.01"
                        className="input tabular-nums"
                        style={{ textAlign: "right" }}
                        required
                        value={row.amount}
                        onChange={(event) => {
                          const next = event.currentTarget.value;
                          update(index, { amount: next });
                        }}
                      />
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-label={`Remove cheque ${index + 1}`}
                        onClick={() =>
                          setRows((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="text-right font-semibold">
                    {rows.length} cheque{rows.length === 1 ? "" : "s"}
                  </td>
                  <td className="text-right tabular-nums font-semibold">
                    {money(total)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-sm muted mb-3">
            None recorded. Add one for each cheque handed over.
          </p>
        )}

        <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
          + Add cheque
        </button>
      </div>
    </section>
  );
}
