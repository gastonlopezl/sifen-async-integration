import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { withTransaction } from "@/lib/db/pool";
import {
  claimQueuedDocuments,
  reserveForDispatch,
  markSent,
  markRejected,
  releaseToQueue,
  type QueuedDocument,
} from "@/lib/db/documents";
import { sendLote, type SifenEnv } from "@/lib/sifen/client";
import { isStubMode } from "@/lib/env";
import { runStub } from "@/lib/sifen/stub";
import { loadCertificate } from "@/lib/sifen/certificate";
import type { PgListener } from "./pg-listener";

// Max DEs per lote. SET caps it at 50 (Manual v150 9.2). We fill toward 50 to
// minimize the number of SET round trips: 1000 stores at 10 DE/day is ~200 lotes
// instead of 10k synchronous requests.
const MAX_DES_PER_LOTE = 50;

// Coalesce a burst of NOTIFYs into one cycle. Also doubles as the batching
// window: NOTIFYs that land inside it ride the same dispatch.
const WAKE_COALESCE_MS = 1_000;

// Safety-net sweep for a NOTIFY that never arrived (a restart between the INSERT
// and the LISTEN connecting). NOTIFY is the primary path; this is the backstop.
const FALLBACK_SWEEP_MS = 60_000;

const SWEEP_LIMIT = 500;

// Transient send failures (timeout, 5xx) bump a per-document counter. After this
// many, the lote is marked rejected so a SET outage cannot loop forever. The
// owner sees the rejection and retries manually once SET recovers.
const MAX_DISPATCH_ATTEMPTS = 5;

const DISPATCH_TIMEOUT_MS = 120_000;

// Per-document dispatch key: sha256 of its own signed XML, truncated to fit the
// column. Deterministic, so a worker restart that re-takes the same document
// regenerates the same key and the UNIQUE index blocks the second dispatch.
// Per-document (not per-lote) so a lote with multiple DEs from one issuer cannot
// collide with itself on the unique constraint.
function dispatchKeyFor(xmlSigned: string): string {
  return createHash("sha256").update(xmlSigned).digest("hex").slice(0, 40);
}

// Numeric dispatch id (SET dId), <= 15 digits, derived deterministically from the
// lote content so a re-send maps to the same id.
function dispatchIdFor(signedDes: string[]): string {
  const h = createHash("sha256").update(signedDes.join("|")).digest("hex");
  return (BigInt("0x" + h.slice(0, 15)) % 1_000_000_000_000_000n).toString();
}

export class SifenDispatcher {
  private wakeTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private cycleInFlight: Promise<void> | null = null;
  private readonly parentAbort = new AbortController();

  constructor(private readonly listener: PgListener) {}

  async start(): Promise<void> {
    if (this.stopped) throw new Error("Dispatcher stopped, create a new instance");
    if (this.running) return;
    this.running = true;

    // Manual-only mode. When the outbound IP path to SET is broken or unverified
    // (the classic case: deployed somewhere whose egress IP SET has not adhered),
    // auto-dispatch is a footgun: it hammers SET with timeouts and re-queues
    // forever. With SIFEN_AUTO_DISPATCH=false the dispatcher attaches NO listener,
    // arms NO sweep, and does NO boot drain. The queue only moves when a human
    // runs `npm run drain`. Flip the flag to true once the IP is adhered and the
    // path is proven, with zero code change.
    if (!env.SIFEN_AUTO_DISPATCH) {
      logger.warn("dispatcher.manual_only", {
        note: "SIFEN_AUTO_DISPATCH is false: no NOTIFY, no sweep, no boot drain. Use `npm run drain`.",
      });
      return;
    }

    this.listener.on("document_queued", () => this.scheduleWake());
    this.sweepTimer = setInterval(() => this.scheduleWake(), FALLBACK_SWEEP_MS);
    this.sweepTimer.unref();
    this.scheduleWake();
    logger.info("dispatcher.started", { autoDispatch: true });
  }

  // Manual trigger: drain the queue once, inline, then return. The only emission
  // path when auto-dispatch is off. Reuses the exact same send logic as the
  // automatic loop; it just runs once and resolves so the drain script can exit.
  async drainOnce(): Promise<void> {
    if (this.stopped) throw new Error("Dispatcher stopped, create a new instance");
    const wasRunning = this.running;
    this.running = true;
    try {
      logger.info("dispatcher.drain.start");
      await this.processQueue();
      logger.info("dispatcher.drain.done");
    } finally {
      this.running = wasRunning;
    }
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
    logger.info("dispatcher.stopped");
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
    this.cycleInFlight = this.processQueue()
      .catch((err) => {
        logger.error("dispatcher.cycle_failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.cycleInFlight = null;
      });
  }

  private async processQueue(): Promise<void> {
    // Claim and reserve inside one transaction so the FOR UPDATE SKIP LOCKED
    // hold and the dispatch_key write are atomic against other replicas.
    const reserved = await withTransaction(async (client) => {
      const claimed = await claimQueuedDocuments(client, SWEEP_LIMIT);
      if (claimed.length === 0) return [] as QueuedDocument[];

      const submittedAt = new Date().toISOString();
      const won: QueuedDocument[] = [];
      for (const doc of claimed) {
        const key = dispatchKeyFor(doc.xml_signed!);
        const ok = await reserveForDispatch(client, doc.id, key, submittedAt);
        if (ok) won.push(doc);
      }
      return won;
    });

    if (reserved.length === 0) return;

    for (let i = 0; i < reserved.length; i += MAX_DES_PER_LOTE) {
      if (!this.running) return;
      await this.dispatchLote(reserved.slice(i, i + MAX_DES_PER_LOTE));
    }
  }

  private async dispatchLote(docs: QueuedDocument[]): Promise<void> {
    if (docs.length === 0) return;

    const ids = docs.map((d) => d.id);
    const signedDes = docs.map((d) => d.xml_signed!).filter(Boolean);
    if (signedDes.length !== docs.length) {
      await markRejected(ids, "MISSING_XML", "Some documents had no signed XML");
      return;
    }

    const dispatchId = dispatchIdFor(signedDes);
    const sifenEnv = env.SIFEN_ENV as SifenEnv;
    const mtls = loadCertificate();

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), DISPATCH_TIMEOUT_MS);
    timeout.unref();
    const onParent = () => abort.abort();
    this.parentAbort.signal.addEventListener("abort", onParent, { once: true });

    try {
      const result = await sendLote(dispatchId, signedDes, sifenEnv, mtls, abort.signal);

      if (result.accepted && result.protocolNumber) {
        // Tell the stub which CDCs this protocol covers so the poll returns one
        // approved entry per CDC. A no-op against real SET.
        if (isStubMode()) {
          runStub.registerCdcs(result.protocolNumber, docs.map((d) => d.cdc));
        }

        const delaySecs = Math.max(60, Math.min((result.processingSeconds ?? 60) * 2, 600));
        const nextPollAt = new Date(Date.now() + delaySecs * 1_000).toISOString();
        await markSent(ids, result.protocolNumber, nextPollAt, result.responseCode, result.responseMessage);
        logger.info("dispatcher.lote_sent", {
          dispatchId,
          count: docs.length,
          protocolNumber: result.protocolNumber,
          firstPollSecs: delaySecs,
        });
        return;
      }

      // SET rejected the lote (e.g. 0301 structural). Re-sending the same lote
      // yields the same error, so do not re-queue; mark rejected for the owner.
      await markRejected(ids, result.responseCode, result.responseMessage);
      logger.warn("dispatcher.lote_rejected", {
        dispatchId,
        code: result.responseCode,
        message: result.responseMessage,
      });
    } catch (err) {
      await this.handleTransient(ids, err);
    } finally {
      clearTimeout(timeout);
      this.parentAbort.signal.removeEventListener("abort", onParent);
    }
  }

  // A transport failure (timeout, socket hang up, 5xx) is the signature of a
  // broken outbound path: the classic case is the deploy's egress IP not being
  // adhered to SET, so every send times out. Bump the counter, and after the cap
  // mark rejected so the loop cannot run forever. Below the cap, return the docs
  // to the queue for the next tick.
  private async handleTransient(ids: string[], err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    // poll_attempts doubles as the dispatch retry counter here. A document is
    // either pre-send (dispatch retries) or post-send (poll retries), never both
    // at once, so the two lifecycles do not overlap on the column. The cap below
    // and the poller's own cap each read the value in their own phase.
    const { rows } = await import("@/lib/db/pool").then((m) =>
      m.pool.query<{ poll_attempts: number }>(
        `SELECT poll_attempts FROM documents WHERE id = ANY($1::uuid[]) ORDER BY poll_attempts DESC LIMIT 1`,
        [ids],
      ),
    );
    const attempts = (rows[0]?.poll_attempts ?? 0) + 1;

    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      logger.error("dispatcher.give_up", { attempts, reason: message });
      await markRejected(ids, "DSP_FAIL", `Dispatch failed ${attempts}x: ${message.slice(0, 200)}`);
      return;
    }

    logger.warn("dispatcher.transient", { attempts, max: MAX_DISPATCH_ATTEMPTS, reason: message });
    await releaseToQueue(ids, attempts, message);
  }
}
