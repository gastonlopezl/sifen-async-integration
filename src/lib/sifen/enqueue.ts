import { withTransaction } from "@/lib/db/pool";
import {
  insertQueuedDocument,
  nextSequence,
  type DocumentRow,
} from "@/lib/db/documents";
import { loadIssuer } from "./issuer";
import { assertTimbradoActive, assertValidCdc, assertValidRucDv } from "./guards";
import { buildCdc, formatDocumentNumber, type DocumentType } from "./cdc";
import { buildUnsignedDe, type DocumentDraft } from "./xml";
import { signDe } from "./sign";

export type EnqueueInput = {
  documentType: DocumentType;
  customerRuc: string;
  customerName: string;
  totalPyg: number;
};

export type EnqueueResult = {
  id: string;
  documentNumber: string;
  cdc: string;
  status: DocumentRow["sifen_status"];
};

// Build a complete, signed DE and put it on the queue, all in one transaction.
//
// Order matters and the guards run FIRST, before any XML or CDC work: an invalid
// RUC or an expired timbrado must fail with a precise message at enqueue time,
// not get baked into a 44-digit CDC that SET later rejects with no hint. Once the
// document is queued, the pg_notify trigger wakes the dispatcher; nothing else in
// the request path talks to SET. That is the whole reason this is async: the HTTP
// caller gets an id back in milliseconds and never waits on SET's clock.
export async function enqueueDocument(input: EnqueueInput): Promise<EnqueueResult> {
  const issuer = loadIssuer();

  assertValidRucDv(issuer.ruc, issuer.dv);
  assertTimbradoActive(issuer);

  return withTransaction(async (client) => {
    const sequence = await nextSequence(client);
    const documentNumber = formatDocumentNumber(issuer, sequence);
    const issueDate = new Date();

    const cdc = buildCdc({
      issuer,
      documentType: input.documentType,
      documentNumber,
      issueDate,
    });
    assertValidCdc(cdc);

    const draft: DocumentDraft = {
      cdc,
      documentType: input.documentType,
      documentNumber,
      issueDate,
      customerRuc: input.customerRuc,
      customerName: input.customerName,
      totalPyg: input.totalPyg,
    };

    const unsigned = buildUnsignedDe(issuer, draft);
    const xmlSigned = signDe(unsigned, cdc);

    const row = await insertQueuedDocument(client, {
      documentNumber,
      cdc,
      customerRuc: input.customerRuc,
      customerName: input.customerName,
      totalPyg: input.totalPyg,
      xmlSigned,
    });

    return {
      id: row.id,
      documentNumber: row.document_number,
      cdc: row.cdc,
      status: row.sifen_status,
    };
  });
}
