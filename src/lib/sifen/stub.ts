import { createHash } from "node:crypto";
import type { ConsultResult, LoteResult, LoteSendResult } from "./client";

// In-process simulation of SET's async lote lifecycle, so the whole pipeline
// (enqueue -> dispatch -> poll -> approve) runs with no certificate and no real
// network. It models the one timing behaviour the poller's backoff exists for: a
// lote is "processing" for a short window, then "processed".
//
// The map is bounded: a lote is deleted the first time it is polled in the
// processed state, so it cannot grow without bound. It is process-local on
// purpose: the stub is for a single dev/CI worker, never production.
type StubLote = {
  protocolNumber: string;
  cdcs: string[];
  processedAfter: number;
};

const lotes = new Map<string, StubLote>();

// How long a stub lote stays "processing" before it flips to "processed". Short
// enough to keep a test fast, long enough that a first poll can legitimately
// catch the processing state and exercise the backoff path.
const STUB_PROCESSING_MS = 1_500;

// Deterministic protocol number from the dispatch id, so a given dispatch always
// maps to the same lote across calls within a run.
function protocolFor(dispatchId: string): string {
  const h = createHash("sha256").update(dispatchId).digest("hex");
  return BigInt("0x" + h.slice(0, 16)).toString().slice(0, 15);
}

export const runStub = {
  // Registers a lote and "accepts" it, exactly like a 0300 from SET. The CDCs are
  // recovered from the signed DEs by the dispatcher before this call, so here we
  // only need the count to build the entry list later via the poll lookup.
  sendLote(dispatchId: string, _count: number): LoteSendResult {
    const protocolNumber = protocolFor(dispatchId);
    if (!lotes.has(protocolNumber)) {
      lotes.set(protocolNumber, {
        protocolNumber,
        cdcs: [],
        processedAfter: Date.now() + STUB_PROCESSING_MS,
      });
    }
    return {
      accepted: true,
      responseCode: "0300",
      responseMessage: "Lote recibido (stub)",
      protocolNumber,
      processingSeconds: 1,
    };
  },

  // Lets the dispatcher tell the stub which CDCs belong to a protocol, so the
  // processed result can return one approved entry per CDC. Called right after
  // sendLote in stub mode.
  registerCdcs(protocolNumber: string, cdcs: string[]): void {
    const lote = lotes.get(protocolNumber);
    if (lote) lote.cdcs = cdcs;
  },

  pollLote(protocolNumber: string): LoteResult {
    const lote = lotes.get(protocolNumber);
    if (!lote) {
      return {
        state: "not_found",
        responseCode: "0360",
        responseMessage: "Lote inexistente (stub)",
        entries: [],
      };
    }
    if (Date.now() < lote.processedAfter) {
      return {
        state: "processing",
        responseCode: "0361",
        responseMessage: "Lote en procesamiento (stub)",
        entries: [],
      };
    }
    lotes.delete(protocolNumber);
    return {
      state: "processed",
      responseCode: "0362",
      responseMessage: "Procesamiento concluido (stub)",
      entries: lote.cdcs.map((cdc) => ({
        cdc,
        estado: "Aprobado",
        approved: true,
        responseCode: "0260",
        responseMessage: "Autorizacion satisfactoria (stub)",
      })),
    };
  },

  consultDe(_cdc: string): ConsultResult {
    return {
      approved: true,
      responseCode: "0422",
      responseMessage: "CDC encontrado (stub)",
      estado: "Aprobado",
    };
  },
};
