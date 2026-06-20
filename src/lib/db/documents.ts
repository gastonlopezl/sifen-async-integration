import type { PoolClient } from "pg";
import { pool } from "./pool";

// Explicit row shapes and explicit column lists. No SELECT *, no raw row ever
// crossing an API boundary: the status route projects to a DTO before returning.

export type DocumentStatus = "queued" | "sent" | "approved" | "rejected" | "cancelled";

export type DocumentRow = {
  id: string;
  document_number: string;
  cdc: string;
  customer_ruc: string;
  customer_name: string;
  total_pyg: string;
  xml_signed: string | null;
  sifen_status: DocumentStatus;
  protocol_number: string | null;
  dispatch_key: string | null;
  submitted_at: string | null;
  next_poll_at: string | null;
  poll_attempts: number;
  response_code: string | null;
  response_message: string | null;
  last_error: string | null;
  created_at: string;
  approved_at: string | null;
};

export type QueuedDocument = Pick<
  DocumentRow,
  "id" | "cdc" | "document_number" | "xml_signed"
>;

export type InsertDocument = {
  documentNumber: string;
  cdc: string;
  customerRuc: string;
  customerName: string;
  totalPyg: number;
  xmlSigned: string;
};

// Insert a freshly signed document straight into the queue. ON CONFLICT on the
// document number makes the enqueue idempotent: a retried POST with the same
// number returns the existing row instead of creating a duplicate DE.
export async function insertQueuedDocument(
  client: PoolClient,
  doc: InsertDocument,
): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    `INSERT INTO documents
       (document_number, cdc, customer_ruc, customer_name, total_pyg, xml_signed, sifen_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued')
     ON CONFLICT (document_number) DO UPDATE SET document_number = EXCLUDED.document_number
     RETURNING id, document_number, cdc, customer_ruc, customer_name, total_pyg,
               xml_signed, sifen_status, protocol_number, dispatch_key, submitted_at,
               next_poll_at, poll_attempts, response_code, response_message, last_error,
               created_at, approved_at`,
    [doc.documentNumber, doc.cdc, doc.customerRuc, doc.customerName, doc.totalPyg, doc.xmlSigned],
  );
  const row = rows[0];
  if (!row) throw new Error("Insert returned no row");
  return row;
}

// Claim queued documents for dispatch. Postgres FOR UPDATE SKIP LOCKED is what
// makes this safe to run from multiple worker replicas: each call locks a
// disjoint set of rows, so no two dispatchers grab the same document. The lock
// is held only for the life of the surrounding transaction.
export async function claimQueuedDocuments(
  client: PoolClient,
  limit: number,
): Promise<QueuedDocument[]> {
  const { rows } = await client.query<QueuedDocument>(
    `SELECT id, cdc, document_number, xml_signed
       FROM documents
      WHERE sifen_status = 'queued'
        AND dispatch_key IS NULL
        AND xml_signed IS NOT NULL
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

// Reserve one document with its deterministic dispatch_key. The WHERE guard plus
// the UNIQUE index on dispatch_key is the idempotency boundary: if another worker
// already reserved this document with the same key, the update affects zero rows
// and we know to skip it. Returns true if THIS call won the reservation.
export async function reserveForDispatch(
  client: PoolClient,
  id: string,
  dispatchKey: string,
  submittedAt: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE documents
        SET dispatch_key = $2, submitted_at = $3
      WHERE id = $1 AND sifen_status = 'queued' AND dispatch_key IS NULL`,
    [id, dispatchKey, submittedAt],
  );
  return (rowCount ?? 0) > 0;
}

export async function markSent(
  ids: string[],
  protocolNumber: string,
  nextPollAt: string,
  responseCode: string,
  responseMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET sifen_status = 'sent',
            protocol_number = $2,
            next_poll_at = $3,
            response_code = $4,
            response_message = $5,
            last_error = NULL
      WHERE id = ANY($1::uuid[])`,
    [ids, protocolNumber, nextPollAt, responseCode, responseMessage],
  );
}

// Return reserved documents to the queue after a transient send failure, bumping
// the attempt counter so a prolonged SET outage can be detected and capped.
export async function releaseToQueue(
  ids: string[],
  attempts: number,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET dispatch_key = NULL,
            submitted_at = NULL,
            poll_attempts = $2,
            last_error = $3
      WHERE id = ANY($1::uuid[])`,
    [ids, attempts, reason.slice(0, 1000)],
  );
}

export async function markRejected(
  ids: string[],
  code: string,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET sifen_status = 'rejected',
            response_code = $2,
            response_message = $3,
            last_error = $3,
            next_poll_at = NULL
      WHERE id = ANY($1::uuid[])`,
    [ids, code, message.slice(0, 1000)],
  );
}

export type PendingProtocolRow = {
  id: string;
  cdc: string;
  protocol_number: string;
  poll_attempts: number;
};

// Documents whose poll time has arrived. The partial index documents_poll_due_idx
// keeps this a cheap index scan even with a large table.
export async function fetchPollDue(limit: number): Promise<PendingProtocolRow[]> {
  const { rows } = await pool.query<PendingProtocolRow>(
    `SELECT id, cdc, protocol_number, poll_attempts
       FROM documents
      WHERE sifen_status = 'sent'
        AND protocol_number IS NOT NULL
        AND next_poll_at <= now()
      ORDER BY next_poll_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function scheduleNextPoll(
  ids: string[],
  attempts: number,
  nextPollAt: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET poll_attempts = $2, next_poll_at = $3, last_error = $4
      WHERE id = ANY($1::uuid[])`,
    [ids, attempts, nextPollAt, reason.slice(0, 1000)],
  );
}

export async function markStuck(
  ids: string[],
  attempts: number,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET poll_attempts = $2, next_poll_at = NULL, last_error = $3
      WHERE id = ANY($1::uuid[])`,
    [ids, attempts, `Stuck after ${attempts} polls: ${reason}`.slice(0, 1000)],
  );
}

// Apply a per-CDC terminal result from the lote. The status guard prevents a
// concurrent transition (e.g. the consultDE fallback) from being overwritten.
export async function applyCdcResult(
  cdc: string,
  approved: boolean,
  code: string,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE documents
        SET sifen_status = $2,
            response_code = $3,
            response_message = $4,
            last_error = CASE WHEN $2 = 'approved' THEN NULL ELSE $4 END,
            next_poll_at = NULL,
            approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END
      WHERE cdc = $1 AND sifen_status = 'sent'`,
    [cdc, approved ? "approved" : "rejected", code, message.slice(0, 1000)],
  );
}

export async function findByCdc(cdc: string): Promise<DocumentRow | null> {
  const { rows } = await pool.query<DocumentRow>(
    `SELECT id, document_number, cdc, customer_ruc, customer_name, total_pyg,
            xml_signed, sifen_status, protocol_number, dispatch_key, submitted_at,
            next_poll_at, poll_attempts, response_code, response_message, last_error,
            created_at, approved_at
       FROM documents WHERE cdc = $1`,
    [cdc],
  );
  return rows[0] ?? null;
}

export async function nextSequence(client: PoolClient): Promise<number> {
  // The demo derives the next document number from the current row count. Real
  // issuers pull this from a per-(establishment, expedition) sequence so two
  // concurrent enqueues never collide; the UNIQUE on document_number is the
  // backstop either way.
  const { rows } = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM documents`,
  );
  return Number(rows[0]?.n ?? "0") + 1;
}
