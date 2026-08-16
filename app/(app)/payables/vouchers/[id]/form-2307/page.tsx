import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintButton } from "@/components/print-button";
import { requirePermission } from "@/lib/auth";
import { round2 } from "@/lib/billing";
import { money } from "@/lib/format";
import { MODULE } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "BIR Form 2307" };

type VoucherFor2307 = {
  id: string;
  company_id: string;
  voucher_no: string;
  voucher_date: string;
  withholding_tax: string | null;
  vendors: {
    name: string;
    tin: string | null;
    address: string | null;
    zip_code: string | null;
    atc_code: string | null;
  } | null;
  voucher_lines: {
    id: string;
    amount: string;
    supplier_invoices: {
      bill_no: string;
      invoice_no: string;
      invoice_date: string;
      amount: string;
      vat_amount: string;
      withholding_tax: string;
      total: string;
    } | null;
  }[];
};

/** BIR writes dates MMDDYYYY, one digit to a box. */
function dateDigits(iso: string | null | undefined) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}${d}${y}`;
}

/** A TIN goes in as digits only; the form supplies the dashes. */
function tinDigits(tin: string | null | undefined) {
  return (tin ?? "").replace(/[^0-9]/g, "");
}

/**
 * The little character boxes the form is ruled into.
 *
 * One box per character, filled from the left and left empty past the end of
 * whatever is being written, exactly as the printed form behaves. The branch
 * code at the end of a TIN is shaded on the original, so it is shaded here.
 */
function Boxes({
  value,
  count,
  from = 0,
  shaded = false,
}: {
  value: string;
  count: number;
  from?: number;
  shaded?: boolean;
}) {
  return (
    <span className="cels">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={shaded ? "cel sh" : "cel"}>
          {value[from + index] ?? ""}
        </span>
      ))}
    </span>
  );
}

function Tin({ value }: { value: string }) {
  return (
    <span className="tin">
      <Boxes value={value} count={3} from={0} />
      <span className="dash">-</span>
      <Boxes value={value} count={3} from={3} />
      <span className="dash">-</span>
      <Boxes value={value} count={3} from={6} />
      <span className="dash">-</span>
      <Boxes value={value} count={5} from={9} shaded />
    </span>
  );
}

/**
 * Certificate of Creditable Tax Withheld at Source, for one voucher.
 *
 * Ruled to follow the printed January 2018 (ENCS) form box for box, so it can
 * be handed over as a computer-generated certificate and read against the BIR
 * original without anyone having to look for anything.
 *
 * Issued with the cheque, so it covers the bills that payment settled. Each
 * bill keeps its own line -- an examiner checking the certificate against the
 * supplier's invoices should find each invoice, not a lump sum to take apart.
 * Every figure is read from what was billed and withheld, so the certificate
 * cannot disagree with the voucher it was printed from.
 */
export default async function Form2307Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requirePermission(MODULE.payablesVouchers, "view");
  const companyId = context.activeCompany!.companyId;

  const supabase = await createClient();
  const [{ data: voucher }, { data: company }] = await Promise.all([
    supabase
      .from("check_vouchers")
      .select(
        `id, company_id, voucher_no, voucher_date, withholding_tax,
         vendors(name, tin, address, zip_code, atc_code),
         voucher_lines(id, amount,
           supplier_invoices(bill_no, invoice_no, invoice_date, amount,
             vat_amount, withholding_tax, total))`,
      )
      .eq("id", id)
      .maybeSingle<VoucherFor2307>(),
    supabase
      .from("companies")
      .select("name, legal_name, tin, address, zip_code")
      .eq("id", companyId)
      .single(),
  ]);

  if (!voucher || voucher.company_id !== companyId) notFound();

  const lines = voucher.voucher_lines ?? [];

  /*
   * Each bill's share of this payment, in the month column its own invoice
   * date falls in. Pro-rated, so a voucher settling half a bill certifies
   * half its withholding rather than all of it.
   */
  const rows = lines
    .filter((line) => line.supplier_invoices)
    .map((line) => {
      const bill = line.supplier_invoices!;
      const billTotal = Number(bill.total) || 0;
      const share = billTotal > 0 ? Number(line.amount) / billTotal : 0;
      const date = bill.invoice_date.slice(0, 10);
      return {
        id: line.id,
        billNo: bill.bill_no,
        invoiceNo: bill.invoice_no,
        date,
        // Month within its own quarter: January is the 1st, February the
        // 2nd, March the 3rd, then it begins again.
        monthIndex: (Number(date.slice(5, 7)) - 1) % 3,
        net: round2(Number(bill.amount) * share),
        tax: round2(Number(bill.withholding_tax) * share),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const dates = rows.map((row) => row.date).sort();
  const earliest = dates[0] ?? voucher.voucher_date.slice(0, 10);
  const latest = dates[dates.length - 1] ?? earliest;

  const totalNet = round2(rows.reduce((sum, row) => sum + row.net, 0));
  const totalTax = round2(
    rows.reduce((sum, row) => sum + row.tax, 0) +
      Number(voucher.withholding_tax ?? 0),
  );
  const monthTotals = [0, 1, 2].map((index) =>
    round2(
      rows
        .filter((row) => row.monthIndex === index)
        .reduce((sum, row) => sum + row.net, 0),
    ),
  );

  // The printed form is ruled to a fixed depth whatever it carries.
  const EWT_ROWS = 14;
  const BUSINESS_TAX_ROWS = 14;
  const blankRows = Math.max(0, EWT_ROWS - rows.length);

  const missing = [
    !company?.tin ? "your TIN" : null,
    !company?.address ? "your registered address" : null,
    !voucher.vendors?.tin ? "the supplier's TIN" : null,
    !voucher.vendors?.address ? "the supplier's registered address" : null,
    !voucher.vendors?.atc_code ? "the supplier's ATC code" : null,
  ].filter(Boolean);

  return (
    <>
      <div className="no-print flex items-center justify-between gap-3 flex-wrap mb-5">
        <Link
          href={`/payables/vouchers/${voucher.id}`}
          className="btn btn-secondary btn-sm"
        >
          Back to {voucher.voucher_no}
        </Link>
        <PrintButton label="Print / Save as PDF" />
      </div>

      {missing.length > 0 ? (
        <div className="no-print card mb-5">
          <div className="card-body">
            <p className="text-sm">
              <strong>This certificate will print with gaps.</strong> BIR asks
              for {missing.join(", ")}. Fill{" "}
              {missing.length === 1 ? "it" : "them"} in and print again, or
              complete the form by hand.
            </p>
          </div>
        </div>
      ) : null}

      <div className="f2307">
        {/* Masthead: the two small BIR-use boxes, the seal block, the barcode
            strip -- unruled above, ruled from the form-number row down. */}
        <table className="head">
          <tbody>
            <tr>
              <td className="bir-use">
                <span className="b1">
                  For BIR
                  <br />
                  Use Only
                </span>
                <span className="b2">
                  BCS/
                  <br />
                  Item:
                </span>
              </td>
              <td className="seal">
                <span className="ring">BIR</span>
                <br />
                Republic of the Philippines
                <br />
                Department of Finance
                <br />
                Bureau of Internal Revenue
              </td>
              <td className="pad" />
            </tr>
          </tbody>
        </table>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="formno">
                BIR Form No.
                <div className="no">2307</div>
                January 2018 (ENCS)
              </td>
              <td className="title">
                Certificate of Creditable Tax
                <br />
                Withheld at Source
              </td>
              <td className="barcode">
                <div className="strip" />
                <div className="code">2307 01/18ENCS</div>
              </td>
            </tr>
          </tbody>
        </table>

        <p className="instruct">
          Fill in all applicable spaces. Mark all appropriate boxes with an
          &ldquo;X&rdquo;.
        </p>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl" style={{ width: "13%" }}>
                <b>1</b> &nbsp;For the Period
              </td>
              <td className="lbl ctr" style={{ width: "6%" }}>
                From
              </td>
              <td style={{ width: "22%" }}>
                <Boxes value={dateDigits(earliest)} count={8} />
              </td>
              <td className="lbl it ctr" style={{ width: "15%" }}>
                (MM/DD/YYYY)
              </td>
              <td className="lbl ctr" style={{ width: "6%" }}>
                To
              </td>
              <td style={{ width: "22%" }}>
                <Boxes value={dateDigits(latest)} count={8} />
              </td>
              <td className="lbl it ctr">(MM/DD/YYYY)</td>
            </tr>
          </tbody>
        </table>

        <div className="band">Part I &ndash; Payee Information</div>
        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl" style={{ width: "36%" }}>
                <b>2</b> &nbsp;Taxpayer Identification Number (TIN)
              </td>
              <td>
                <Tin value={tinDigits(voucher.vendors?.tin)} />
              </td>
            </tr>
            <tr>
              <td className="lbl" colSpan={2}>
                <b>3</b> &nbsp;Payee&rsquo;s Name{" "}
                <i>
                  (Last Name, First Name, Middle Name for Individual OR
                  Registered Name for Non-Individual)
                </i>
              </td>
            </tr>
            <tr>
              <td className="fill" colSpan={2}>
                {voucher.vendors?.name ?? ""}
              </td>
            </tr>
          </tbody>
        </table>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl">
                <b>4</b> &nbsp;Registered Address
              </td>
              <td className="lbl right" style={{ width: "22%" }}>
                <b>4A</b> &nbsp;ZIP Code
              </td>
            </tr>
            <tr>
              <td className="fill">{voucher.vendors?.address ?? ""}</td>
              <td>
                <Boxes value={voucher.vendors?.zip_code ?? ""} count={4} />
              </td>
            </tr>
            <tr>
              <td className="lbl" colSpan={2}>
                <b>5</b> &nbsp;Foreign Address, <i>if applicable</i>
              </td>
            </tr>
            <tr>
              <td className="fill" colSpan={2} />
            </tr>
          </tbody>
        </table>

        <div className="band">Part II &ndash; Payor Information</div>
        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl" style={{ width: "36%" }}>
                <b>6</b> &nbsp;Taxpayer Identification Number <i>(TIN)</i>
              </td>
              <td>
                <Tin value={tinDigits(company?.tin)} />
              </td>
            </tr>
            <tr>
              <td className="lbl" colSpan={2}>
                <b>7</b> &nbsp;Payor&rsquo;s Name{" "}
                <i>
                  (Last Name, First Name, Middle Name for Individual OR
                  Registered Name for Non-Individual)
                </i>
              </td>
            </tr>
            <tr>
              <td className="fill" colSpan={2}>
                {company?.legal_name ?? company?.name ?? ""}
              </td>
            </tr>
          </tbody>
        </table>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl">
                <b>8</b> &nbsp;Registered Address
              </td>
              <td className="lbl right" style={{ width: "22%" }}>
                <b>8A</b> &nbsp;ZIP Code
              </td>
            </tr>
            <tr>
              <td className="fill">{company?.address ?? ""}</td>
              <td>
                <Boxes value={company?.zip_code ?? ""} count={4} />
              </td>
            </tr>
          </tbody>
        </table>

        <div className="band">
          Part III &ndash; Details of Monthly Income Payments and Taxes Withheld
        </div>
        <table className="ruled grid">
          <tbody>
            <tr>
              <td className="lbl ctr" rowSpan={2} style={{ width: "28%" }}>
                Income Payments Subject to Expanded
                <br />
                Withholding Tax
              </td>
              <td className="lbl ctr" rowSpan={2} style={{ width: "7%" }}>
                ATC
              </td>
              <td className="lbl ctr" colSpan={3}>
                AMOUNT OF INCOME PAYMENTS
              </td>
              <td className="lbl ctr" rowSpan={2} style={{ width: "13%" }}>
                Total
              </td>
              <td className="lbl ctr" rowSpan={2} style={{ width: "14%" }}>
                Tax Withheld for the
                <br />
                Quarter
              </td>
            </tr>
            <tr>
              <td className="lbl ctr" style={{ width: "12.66%" }}>
                1st Month of the
                <br />
                Quarter
              </td>
              <td className="lbl ctr" style={{ width: "12.66%" }}>
                2nd Month of the
                <br />
                Quarter
              </td>
              <td className="lbl ctr" style={{ width: "12.68%" }}>
                3rd Month of the
                <br />
                Quarter
              </td>
            </tr>

            {rows.map((row) => (
              <tr key={row.id}>
                <td className="cellv">
                  {row.billNo}
                  {row.invoiceNo ? ` · Inv. ${row.invoiceNo}` : ""}
                </td>
                <td className="cellv ctr">
                  {voucher.vendors?.atc_code ?? ""}
                </td>
                {[0, 1, 2].map((index) => (
                  <td key={index} className="cellv num">
                    {row.monthIndex === index ? money(row.net) : ""}
                  </td>
                ))}
                <td className="cellv num">{money(row.net)}</td>
                <td className="cellv num">{money(row.tax)}</td>
              </tr>
            ))}
            {Array.from({ length: blankRows }, (_, index) => (
              <tr key={`ewt-${index}`}>
                <td className="cellv">&nbsp;</td>
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
              </tr>
            ))}

            <tr>
              <td className="lbl">
                <b>Total</b>
              </td>
              <td className="cellv" />
              {monthTotals.map((amount, index) => (
                <td key={index} className="cellv num">
                  <b>{amount > 0 ? money(amount) : ""}</b>
                </td>
              ))}
              <td className="cellv num">
                <b>{money(totalNet)}</b>
              </td>
              <td className="cellv num">
                <b>{money(totalTax)}</b>
              </td>
            </tr>

            <tr>
              <td className="lbl ctr shade">
                <b>
                  Money Payments Subject to Withholding of
                  <br />
                  Business Tax (Government &amp; Private)
                </b>
              </td>
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
            </tr>
            {Array.from({ length: BUSINESS_TAX_ROWS }, (_, index) => (
              <tr key={`bt-${index}`}>
                <td className="cellv">&nbsp;</td>
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
                <td className="cellv" />
              </tr>
            ))}
            <tr>
              <td className="lbl">
                <b>Total</b>
              </td>
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
              <td className="cellv" />
            </tr>
          </tbody>
        </table>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="declare">
                We declare under the penalties of perjury that this certificate
                has been made in good faith, verified by us, and to the best of
                our knowledge and belief, is true and correct, pursuant to the
                provisions of the National Internal Revenue Code, as amended,
                and the regulations issued under authority thereof. Further, we
                give our consent to the processing of our information as
                contemplated under the *Data Privacy Act of 2012 (R.A. No.
                10173) for legitimate and lawful purposes.
              </td>
            </tr>
            <tr>
              <td className="signspace" />
            </tr>
            <tr>
              <td className="signband">
                Signature over Printed Name of Payor/Payor&rsquo;s Authorized
                Representative/Tax Agent
                <br />
                <i>(Indicate Title/Designation and TIN)</i>
              </td>
            </tr>
          </tbody>
        </table>

        <table className="ruled">
          <tbody>
            <tr>
              <td className="lbl ctr" style={{ width: "18%" }}>
                Tax Agent Accreditation No./
                <br />
                Attorney&rsquo;s Roll No. <i>(if applicable)</i>
              </td>
              <td style={{ width: "20%" }} />
              <td className="lbl ctr" style={{ width: "13%" }}>
                Date of Issue
                <br />
                <i>(MM/DD/YYYY)</i>
              </td>
              <td style={{ width: "18%" }}>
                <Boxes value="" count={8} />
              </td>
              <td className="lbl ctr" style={{ width: "13%" }}>
                Date of Expiry
                <br />
                <i>(MM/DD/YYYY)</i>
              </td>
              <td>
                <Boxes value="" count={8} />
              </td>
            </tr>
            <tr>
              <td className="conforme" colSpan={6}>
                CONFORME:
              </td>
            </tr>
            <tr>
              <td className="signspace" colSpan={6} />
            </tr>
            <tr>
              <td className="signband" colSpan={6}>
                Signature over Printed Name of Payee/Payee&rsquo;s Authorized
                Representative/Tax Agent
                <br />
                <i>(Indicate Title/Designation and TIN)</i>
              </td>
            </tr>
            <tr>
              <td className="lbl ctr">
                Tax Agent Accreditation No./
                <br />
                Attorney&rsquo;s Roll No. <i>(if applicable)</i>
              </td>
              <td />
              <td className="lbl ctr">
                Date of Issue
                <br />
                <i>(MM/DD/YYYY)</i>
              </td>
              <td>
                <Boxes value="" count={8} />
              </td>
              <td className="lbl ctr">
                Date of Expiry
                <br />
                <i>(MM/DD/YYYY)</i>
              </td>
              <td>
                <Boxes value="" count={8} />
              </td>
            </tr>
          </tbody>
        </table>

        <p className="footnote">
          *NOTE: The BIR Data Privacy is in the BIR website (www.bir.gov.ph)
        </p>
      </div>

      <style>{`
        .f2307 {
          background: #fff;
          color: #000;
          width: 186mm;
          margin: 0 auto;
          font-family: Arial, Helvetica, sans-serif;
          font-size: 6.5pt;
          line-height: 1.15;
        }
        .f2307 table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .f2307 .ruled td { border: 1px solid #000; padding: 1px 3px; vertical-align: middle; }
        .f2307 .ruled + .ruled,
        .f2307 .band + .ruled,
        .f2307 .ruled + .band { margin-top: -1px; }
        .f2307 .lbl { font-size: 6pt; }
        .f2307 .shade { background: #d9d9d9; }
        .f2307 .ctr { text-align: center; }
        .f2307 .right { text-align: right; }
        .f2307 .it, .f2307 i { font-style: italic; }
        .f2307 .num { text-align: right; font-variant-numeric: tabular-nums; }

        /* Masthead */
        .f2307 .head td { padding: 0 0 2px; vertical-align: top; border: 0; }
        .f2307 .bir-use { width: 22%; font-size: 5.5pt; }
        .f2307 .bir-use .b1, .f2307 .bir-use .b2 {
          display: inline-block; border: 1px solid #000; padding: 1px 3px;
          margin-right: -1px; text-align: center; vertical-align: top;
        }
        .f2307 .seal { text-align: center; font-size: 6.5pt; font-weight: 700; }
        .f2307 .seal .ring {
          display: inline-block; width: 18px; height: 18px; border: 1px solid #000;
          border-radius: 50%; font-size: 5pt; line-height: 18px; margin-bottom: 1px;
        }
        .f2307 .pad { width: 22%; }

        .f2307 .formno { width: 22%; text-align: center; font-size: 5.5pt; }
        .f2307 .formno .no { font-size: 17pt; font-weight: 700; line-height: 1; }
        .f2307 .title { text-align: center; font-size: 13pt; font-weight: 700; }
        .f2307 .barcode { width: 22%; text-align: right; padding: 2px 3px 1px; }
        .f2307 .barcode .strip { height: 28px; border: 1px solid #000; }
        .f2307 .barcode .code { font-size: 5.5pt; }

        .f2307 .instruct { font-size: 5.5pt; margin: 1px 0; }

        /* Part bands */
        .f2307 .band {
          border: 1px solid #000; border-bottom: 0; background: #d9d9d9;
          text-align: center; font-weight: 700; font-size: 6.5pt; padding: 1px 0;
        }

        /* Character boxes */
        .f2307 .cels { display: inline-block; white-space: nowrap; }
        .f2307 .cel {
          display: inline-block; width: 13px; height: 12px; line-height: 12px;
          border: 1px solid #000; margin-right: -1px; text-align: center;
          font-size: 7.5pt; vertical-align: middle;
        }
        .f2307 .cel.sh { background: #d9d9d9; }
        .f2307 .tin .dash { display: inline-block; padding: 0 3px; }

        /* Written-in values */
        .f2307 .fill { height: 20px; font-size: 8pt; font-weight: 700; }
        .f2307 .cellv { height: 12px; font-size: 6.5pt; }
        .f2307 .grid .cellv { padding: 0 3px; }

        /* Declaration and signatures */
        .f2307 .declare { font-size: 6pt; text-align: justify; padding: 3px 5px; line-height: 1.25; }
        .f2307 .signspace { height: 34px; }
        .f2307 .signband {
          background: #d9d9d9; text-align: center; font-size: 6pt; padding: 1px 0;
        }
        .f2307 .conforme { font-weight: 700; font-size: 6.5pt; text-align: center; }
        .f2307 .footnote { font-size: 5.5pt; margin-top: 1px; }

        /* 186mm is exactly A4 less the 12mm margins the app already prints
           with, so the sheet lands on paper at the size it is ruled at. */
        @media print {
          .f2307 { width: 186mm; }
          .f2307 .shade, .f2307 .band, .f2307 .signband, .f2307 .cel.sh {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
      `}</style>
    </>
  );
}
