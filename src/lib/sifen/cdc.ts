import { randomInt } from "node:crypto";
import type { Issuer } from "./issuer";

// The CDC ("Codigo de Control") is the 44-digit identifier SET assigns every
// electronic document. It is NOT random: it is assembled from the document's own
// fields in a fixed layout, then closed with a Modulo 11 check digit. Because it
// is deterministic from those fields, we can build it ourselves at enqueue time
// and use it as the join key against SET's per-DE response, before SET has even
// seen the document.
//
// Layout (43 digits + 1 check digit), per SIFEN's technical manual:
//   2   document type (iTiDE: 01 invoice, 04 auto-invoice, 05/06 notes, 07 remito)
//   8   issuer RUC (left-padded)
//   1   issuer RUC check digit
//   3   establishment
//   3   expedition point
//   7   document number
//   1   contributor type (1 = persona fisica/juridica)
//   8   issue date YYYYMMDD
//   1   emission type (1 = normal)
//   9   security code (random, 9 digits)
//   ---
//   43  subtotal, then 1 check digit = 44
//
// Getting any field width or order wrong yields a CDC that SET rejects with no
// hint, so the widths below are load-bearing.

export type DocumentType = "01" | "04" | "05" | "06" | "07";

type CdcInput = {
  issuer: Issuer;
  documentType: DocumentType;
  documentNumber: string;
  issueDate: Date;
};

function pad(value: string | number, width: number): string {
  return String(value).padStart(width, "0").slice(-width);
}

// Modulo 11 over the 43-digit body, weights cycling 2..11. This is the same
// family of check digit as the RUC DV but applied to the assembled CDC body.
function cdcCheckDigit(body: string): number {
  let total = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    total += Number(body[i]) * factor;
    factor = factor > 10 ? 2 : factor + 1;
  }
  const remainder = total % 11;
  const dv = 11 - remainder;
  // 10 and 11 collapse to 0 by the manual's rule.
  return dv > 9 ? 0 : dv;
}

export function buildCdc(input: CdcInput): string {
  const { issuer, documentType, documentNumber, issueDate } = input;

  const securityCode = pad(randomInt(0, 1_000_000_000), 9);
  const yyyymmdd =
    `${issueDate.getUTCFullYear()}` +
    pad(issueDate.getUTCMonth() + 1, 2) +
    pad(issueDate.getUTCDate(), 2);

  const body =
    documentType +
    pad(issuer.ruc, 8) +
    pad(issuer.dv, 1) +
    pad(issuer.establishment, 3) +
    pad(issuer.expeditionPoint, 3) +
    pad(documentNumber, 7) +
    "1" +
    yyyymmdd +
    "1" +
    securityCode;

  return body + String(cdcCheckDigit(body));
}

// The human-facing document number prefix, 001-001-0000001 style. The CDC
// embeds the same establishment/expedition/number; this is what goes on the
// printed KuDE and what we store as the unique business identifier.
export function formatDocumentNumber(
  issuer: Issuer,
  sequence: number,
): string {
  return `${issuer.establishment}-${issuer.expeditionPoint}-${pad(sequence, 7)}`;
}
