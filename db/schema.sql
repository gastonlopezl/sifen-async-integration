-- SIFEN async demo schema.
--
-- One table does the work: documents. It is both the business record (the DE we
-- are issuing) and the queue Postgres drives the whole async flow off. There is
-- no Redis here on purpose: a single Postgres table with the right indexes,
-- SELECT ... FOR UPDATE SKIP LOCKED, and LISTEN/NOTIFY is a complete, horizontally
-- scalable job queue, and it keeps the fiscal record and its dispatch state in
-- one transactional place. SIFEN's whole lifecycle is a state machine on the
-- sifen_status column.
--
-- Access model: this table is written only by the server (the Next API routes
-- enqueue, the worker dispatches and polls). It is never read directly by a
-- browser. If you run this on Supabase and expose it through PostgREST, enable
-- RLS and keep the fiscal data behind the service role only: a DE carries the
-- customer's RUC, the CDC, and the signed XML.

create extension if not exists pgcrypto;

-- The SIFEN state machine. Mirrors the lote lifecycle:
--   queued    -> signed and waiting for the dispatcher to put it in a lote
--   sent      -> lote accepted by SET (dProtConsLote assigned), poller will poll
--   approved  -> SET returned dEstRes 'Aprobado' for this DE's CDC
--   rejected  -> SET rejected the lote (0301) or the DE, or dispatch gave up
--   cancelled -> a cancellation event was approved for an already-approved DE
create type sifen_status as enum (
  'queued',
  'sent',
  'approved',
  'rejected',
  'cancelled'
);

create table documents (
  id                 uuid primary key default gen_random_uuid(),

  -- Document number in the SIFEN format prefix (establishment-expedition-NNNNNNN).
  -- Unique per issuer so we never emit the same number twice.
  document_number    text not null,

  -- CDC: the 44-digit "Codigo de Control" that uniquely identifies this DE in
  -- SIFEN. Derived deterministically from issuer RUC + timbrado + number + a
  -- security code at enqueue time. It is the join key against SET's response.
  cdc                text not null,

  customer_ruc       text not null,
  customer_name      text not null check (char_length(customer_name) between 1 and 255),
  -- PYG has no decimal subunit in practice, but keep NUMERIC for the rare edge
  -- amount and never a float. SIFEN documents are issued in PYG here.
  total_pyg          numeric(15, 2) not null check (total_pyg > 0),

  -- The signed DE XML (<rDE> with the enveloped ds:Signature). This is what the
  -- dispatcher packs into the lote ZIP. Null only between row insert and signing,
  -- which happens in the same transaction, so in practice it is always present.
  xml_signed         text,

  sifen_status       sifen_status not null default 'queued',

  -- The lote protocol number SET returns from siRecepLoteDE (dProtConsLote).
  -- The poller looks up by this to call siResultLoteDE.
  protocol_number    text,

  -- Per-document idempotency key, the sha256 of this row's own xml_signed. A
  -- worker restart that re-takes the same document regenerates the same key, and
  -- the UNIQUE index below blocks the second dispatch. Per-document (not per-lote)
  -- so a lote with more than one DE from the same issuer cannot collide with
  -- itself on the unique constraint.
  dispatch_key       text,

  submitted_at       timestamptz,
  -- When the poller should next call siResultLoteDE. Backoff is encoded by
  -- pushing this further out on each inconclusive poll.
  next_poll_at       timestamptz,
  poll_attempts      smallint not null default 0,

  -- SET's last response code/message for this document (dCodRes / dEstRes path).
  response_code      text,
  response_message   text,
  last_error         text,

  created_at         timestamptz not null default now(),
  approved_at        timestamptz
);

-- The document number is unique per issuer. A retry of the same number can never
-- create a second row.
create unique index documents_document_number_key on documents (document_number);

-- The CDC is the join key against SET's per-DE response. Unique and indexed.
create unique index documents_cdc_key on documents (cdc);

-- Per-document dispatch idempotency. Partial so many null rows (pre-dispatch) do
-- not fight over a single null in the unique index.
create unique index documents_dispatch_key_key
  on documents (dispatch_key)
  where dispatch_key is not null;

-- The dispatcher claims work from here: queued docs with no dispatch_key yet.
create index documents_queued_idx
  on documents (created_at)
  where sifen_status = 'queued' and dispatch_key is null;

-- The poller scans here: sent docs whose poll time has come.
create index documents_poll_due_idx
  on documents (next_poll_at)
  where sifen_status = 'sent' and protocol_number is not null;

-- ============================================================================
-- pg_notify wake-ups. The workers LISTEN on these channels so they react in
-- sub-second instead of polling the table on a timer. The timers in the worker
-- are a safety net for a missed NOTIFY (e.g. a restart between the INSERT and
-- the LISTEN connecting), not the primary path.
-- ============================================================================

create or replace function notify_document_queued() returns trigger
language plpgsql as $$
begin
  if new.sifen_status = 'queued' and new.dispatch_key is null then
    perform pg_notify('document_queued', new.id::text);
  end if;
  return new;
end;
$$;

create trigger trg_notify_document_queued
  after insert or update of sifen_status on documents
  for each row execute function notify_document_queued();

create or replace function notify_lote_sent() returns trigger
language plpgsql as $$
begin
  if new.sifen_status = 'sent' and new.protocol_number is not null then
    perform pg_notify('lote_sent', new.protocol_number);
  end if;
  return new;
end;
$$;

create trigger trg_notify_lote_sent
  after insert or update of sifen_status, protocol_number on documents
  for each row execute function notify_lote_sent();
