import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  fetchPollDue,
  scheduleNextPoll,
  markStuck,
  markRejected,
  applyCdcResult,
  type PendingProtocolRow,
} from "@/lib/db/documents";
import { pollLote, consultDe, type SifenEnv } from "@/lib/sifen/client";
import { loadCertificate } from "@/lib/sifen/certificate";
import type { PgListener } from "./pg-listener";

const WAKE_COALESCE_MS = 1_000;
const FALLBACK_SWEEP_MS = 60_000;
const SWEEP_LIMIT = 100;
const POLL_TIMEOUT_MS = 90_000;
const CONSULT_DE_TIMEOUT_MS = 20_000;

// After this many polls with no terminal answer, the lote is stuck. With the
// 60-minute backoff cap, 24 attempts spans ~24h: a full business day plus margin.
// Beyond it, the document is left for manual review rather than polled forever.
const POLL_MAX_ATTEMPTS = 24;

type Protocol = {
  protocolNumber: string;
  cdcs: string[];
  ids: string[];
  attempts: number;
};

export class SifenPoller {
  private wakeTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private cycleInFlight: Promise<void> | null = null;
  private readonly parentAbort = new AbortController();

  constructor(private readonly listener: PgListener) {}

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Poller stopped, create a new instance");
    if (this.running) return;
    this.running = true;

    // The NOTIFY only guarantees the poller is awake; it still respects
    // next_poll_at and never polls a lote before its scheduled time.
    this.listener.on("lote_sent", () => this.scheduleWake());
    this.sweepTimer = setInterval(() => this.scheduleWake(), FALLBACK_SWEEP_MS);
    this.sweepTimer.unref();
    this.scheduleWake();
    logger.info("poller.started");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wakeTimer = null;
    this.sweepTimer = null;
    this.parentAbort.abort();
    if (this.cycleInFlight) {
      try {
        await this.cycleInFlight;
      } catch {
        // swallow: shutdown
      }
    }
    logger.info("poller.stopped");
  }

  private scheduleWake(): void {
    if (!this.running || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.runCycle();
    }, WAKE_COALESCE_MS);
    this.wakeTimer.unref();
  }

  private runCycle(): void {
    if (!this.running || this.cycleInFlight) return;
    this.cycleInFlight = this.processPending()
      .catch((err) => {
        logger.error("poller.cycle_failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.cycleInFlight = null;
      });
  }

  private async processPending(): Promise<void> {
    const due = await fetchPollDue(SWEEP_LIMIT * 50);
    if (due.length === 0) return;

    const byProtocol = new Map<string, Protocol>();
    for (const row of due) {
      let bucket = byProtocol.get(row.protocol_number);
      if (!bucket) {
        bucket = { protocolNumber: row.protocol_number, cdcs: [], ids: [], attempts: row.poll_attempts };
        byProtocol.set(row.protocol_number, bucket);
      }
      bucket.cdcs.push(row.cdc);
      bucket.ids.push(row.id);
      bucket.attempts = Math.max(bucket.attempts, row.poll_attempts);
    }

    for (const proto of [...byProtocol.values()].slice(0, SWEEP_LIMIT)) {
      if (!this.running) return;
      await this.processProtocol(proto);
    }
  }

  private async processProtocol(proto: Protocol): Promise<void> {
    const sifenEnv = env.SIFEN_ENV as SifenEnv;
    const mtls = loadCertificate();

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
    timeout.unref();
    const onParent = () => abort.abort();
    this.parentAbort.signal.addEventListener("abort", onParent, { once: true });

    let loteError: string | null = null;
    let result = null;
    try {
      result = await pollLote(proto.protocolNumber, sifenEnv, mtls, abort.signal);
    } catch (err) {
      loteError = err instanceof Error ? err.message : String(err);
      logger.warn("poller.lote_transient", { protocolNumber: proto.protocolNumber, reason: loteError });
    } finally {
      clearTimeout(timeout);
      this.parentAbort.signal.removeEventListener("abort", onParent);
    }

    // Conclusive processed result: apply each CDC's terminal status.
    if (result && result.state === "processed") {
      await this.applyProcessed(proto, result.entries);
      return;
    }

    // SET says the lote does not exist (0360). Before rejecting, consult each DE
    // by CDC: a lote can expire on SET's side while the document itself was
    // approved. The per-CDC consult resolves that; only if it also fails do we
    // mark rejected.
    if (result && result.state === "not_found") {
      const resolved = await this.resolveViaConsultDe(proto, sifenEnv, mtls);
      if (resolved) return;
      await markRejected(proto.ids, result.responseCode, result.responseMessage || "Lote not found");
      return;
    }

    // Clean "processing" (0361): SET accepted the consult and says the lote is
    // still running. This is unambiguous. Reschedule with backoff and do NOT run
    // the per-CDC fallback: it would hammer SET with N requests per poll for a
    // result that is not ready anyway.
    if (result && result.state === "processing") {
      await this.scheduleRetry(proto, "SET processing");
      return;
    }

    // Inconclusive: the lote poll hung/aborted or returned an unknown code. SET
    // can hold the siResultLoteDE connection open while it processes, exhausting
    // the timeout without answering. The per-CDC consult answers in ~1s and
    // resolves the real state reliably, so ONLY here do we use it as a fallback
    // before rescheduling. This is the gotcha that un-sticks lotes whose lote
    // poll never returns, without hammering SET on legitimate 0361s.
    const resolved = await this.resolveViaConsultDe(proto, sifenEnv, mtls);
    if (resolved) return;

    await this.scheduleRetry(proto, loteError ?? `Unknown SET code ${result?.responseCode ?? "n/a"}`);
  }

  private async applyProcessed(
    proto: Protocol,
    entries: { cdc: string; approved: boolean; responseCode: string; responseMessage: string }[],
  ): Promise<void> {
    if (entries.length === 0) {
      await this.scheduleRetry(proto, "Processed lote returned no entries");
      return;
    }
    for (const entry of entries) {
      await applyCdcResult(entry.cdc, entry.approved, entry.responseCode, entry.responseMessage);
    }
    logger.info("poller.lote_processed", {
      protocolNumber: proto.protocolNumber,
      entries: entries.length,
      approved: entries.filter((e) => e.approved).length,
    });
  }

  // Per-CDC fallback. For each still-'sent' document in the lote, consult the DE
  // individually. If SET reports it approved (dEstRes 'Aprobado'), apply the
  // approval. Returns true if at least one document resolved to approved.
  private async resolveViaConsultDe(
    proto: Protocol,
    sifenEnv: SifenEnv,
    mtls: { certPem: string; privateKeyPem: string },
  ): Promise<boolean> {
    let resolvedAny = false;
    for (const cdc of proto.cdcs) {
      if (!this.running) break;

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), CONSULT_DE_TIMEOUT_MS);
      timeout.unref();
      const onParent = () => abort.abort();
      this.parentAbort.signal.addEventListener("abort", onParent, { once: true });

      try {
        const de = await consultDe(cdc, sifenEnv, mtls, abort.signal);
        if (!de.approved) {
          logger.info("poller.consult_inconclusive", {
            cdc,
            code: de.responseCode,
            estado: de.estado ?? "n/a",
          });
          continue;
        }
        // applyCdcResult guards on sifen_status='sent', so a concurrent
        // transition cannot be overwritten.
        await applyCdcResult(cdc, true, de.responseCode, de.responseMessage);
        resolvedAny = true;
        logger.info("poller.approved_via_consult", { cdc, protocolNumber: proto.protocolNumber });
      } catch (err) {
        logger.warn("poller.consult_transient", {
          cdc,
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timeout);
        this.parentAbort.signal.removeEventListener("abort", onParent);
      }
    }
    return resolvedAny;
  }

  // Exponential backoff: 5 -> 10 -> 20 -> 40 minutes, capped at 60. After
  // POLL_MAX_ATTEMPTS, mark stuck and stop polling.
  private async scheduleRetry(proto: Protocol, reason: string): Promise<void> {
    const attempts = proto.attempts + 1;
    if (attempts >= POLL_MAX_ATTEMPTS) {
      logger.error("poller.give_up", { protocolNumber: proto.protocolNumber, attempts, reason });
      await markStuck(proto.ids, attempts, reason);
      return;
    }
    const backoffMin = Math.min(5 * 2 ** proto.attempts, 60);
    const nextPollAt = new Date(Date.now() + backoffMin * 60_000).toISOString();
    await scheduleNextPoll(proto.ids, attempts, nextPollAt, reason);
    logger.info("poller.retry_scheduled", {
      protocolNumber: proto.protocolNumber,
      attempts,
      backoffMin,
    });
  }
}
