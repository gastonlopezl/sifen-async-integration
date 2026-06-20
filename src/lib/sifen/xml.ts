import type { Issuer } from "./issuer";
import type { DocumentType } from "./cdc";

// Build the DE (Documento Electronico) XML. The real schema has hundreds of
// optional fields; this is the minimal-but-structurally-faithful core SET needs
// to recognize a document: the CDC as the element id, the issuer (gEmis), the
// receiver (gDatRec), the timbrado (gTimb), and the totals (gTotSub). The point
// of this repo is the async transport, not exhaustive field coverage, so the
// DE here is deliberately a clean subset rather than a copy of any one issuer's
// generator.
//
// One rule that bites everyone: the root <DE> element's Id attribute MUST equal
// the CDC, because the signature reference points at "#" + that Id. Mismatch it
// and the signature verifies against nothing and SET rejects the DE.

export type DocumentDraft = {
  cdc: string;
  documentType: DocumentType;
  documentNumber: string;
  issueDate: Date;
  customerRuc: string;
  customerName: string;
  totalPyg: number;
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isoSeconds(date: Date): string {
  return date.toISOString().slice(0, 19);
}

// Returns the unsigned <rDE> wrapper around a <DE Id="{cdc}">. The signer fills
// in the ds:Signature and (later) the gCamFuFD QR block. We split build from
// sign so the signature covers exactly the canonical DE the way SET expects.
export function buildUnsignedDe(issuer: Issuer, draft: DocumentDraft): string {
  const { cdc, documentType, documentNumber, issueDate, customerRuc, customerName, totalPyg } =
    draft;

  return (
    `<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd">` +
    `<dVerFor>150</dVerFor>` +
    `<DE Id="${cdc}">` +
    `<dDVId>${cdc.slice(-1)}</dDVId>` +
    `<dFecFirma>${isoSeconds(issueDate)}</dFecFirma>` +
    `<dSisFact>1</dSisFact>` +
    `<gOpeDE>` +
    `<iTipEmi>1</iTipEmi>` +
    `<dCodSeg>${cdc.slice(34, 43)}</dCodSeg>` +
    `</gOpeDE>` +
    `<gTimb>` +
    `<iTiDE>${documentType}</iTiDE>` +
    `<dNumTim>${issuer.timbrado}</dNumTim>` +
    `<dEst>${issuer.establishment}</dEst>` +
    `<dPunExp>${issuer.expeditionPoint}</dPunExp>` +
    `<dNumDoc>${documentNumber.split("-").at(-1)}</dNumDoc>` +
    `<dFeIniT>${issuer.timbradoStart}</dFeIniT>` +
    `</gTimb>` +
    `<gDatGralOpe>` +
    `<dFeEmiDE>${isoSeconds(issueDate)}</dFeEmiDE>` +
    `<gEmis>` +
    `<dRucEm>${issuer.ruc}</dRucEm>` +
    `<dDVEmi>${issuer.dv}</dDVEmi>` +
    `</gEmis>` +
    `<gDatRec>` +
    `<dRucRec>${esc(customerRuc)}</dRucRec>` +
    `<dNomRec>${esc(customerName)}</dNomRec>` +
    `</gDatRec>` +
    `</gDatGralOpe>` +
    `<gTotSub>` +
    `<dTotGralOpe>${totalPyg.toFixed(2)}</dTotGralOpe>` +
    `</gTotSub>` +
    `</DE>` +
    `</rDE>`
  );
}
