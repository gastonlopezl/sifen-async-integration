import https from "node:https";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { isStubMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { runStub } from "./stub";

// SIFEN SOAP 1.2 client over mutual TLS.
//
// SET requires mTLS: the client MUST present its X.509 certificate AND private
// key during the TLS handshake. Without it SET answers HTTP 302 to its F5 portal
// (not a SOAP fault), which looks like a redirect bug until you realize the
// handshake never presented a cert. There is no API key and no bearer token: the
// certificate IS the authentication.
//
// SET prod refuses the SYNCHRONOUS receive of a DE by policy (Manual Tecnico
// v150 section 7.10). The only path that works in production is the ASYNC lote:
// build an XML <rLoteDE> of 1..50 signed DEs, ZIP it, Base64 it, POST it inside
// <rEnvioLote> to siRecepLoteDE, get back a lote protocol number, then poll
// siResultLoteDE for the per-DE result. That is why this whole repo is async.

export type SifenEnv = "test" | "prod";

export type SifenMtls = {
  certPem: string;
  privateKeyPem: string;
};

const ENDPOINTS: Record<SifenEnv, string> = {
  test: "https://sifen-test.set.gov.py/de/ws/",
  prod: "https://sifen.set.gov.py/de/ws/",
};

// mTLS cold-start on a fresh socket can land in the 30-60s range; the lote
// endpoint can hold the connection while it processes. 90s gives it room before
// the caller treats the request as a transient failure.
const TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SIFEN_NS = "http://ekuatia.set.gov.py/sifen/xsd";

// SET's F5 load balancer leaves reused keep-alive sockets in a state where they
// hang for the full timeout without returning. A fresh agent per request pays a
// ~200-500ms handshake cost but never hangs. Acceptable for batched lote volume.
function freshAgent(): https.Agent {
  return new https.Agent({ keepAlive: false });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
});

function stripProlog(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, "");
}

function soapEnvelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">` +
    `<env:Header/><env:Body>${body}</env:Body></env:Envelope>`
  );
}

// Low-level SOAP 1.2 POST with mutual TLS. The cert and key are attached to the
// TLS context only; they never appear in a log line or in the request body.
async function soapPost(
  url: string,
  body: string,
  mtls: SifenMtls,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("SIFEN request aborted before dispatch"));
      return;
    }

    const u = new URL(url);
    const envelope = soapEnvelope(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: "POST",
        cert: mtls.certPem,
        key: mtls.privateKeyPem,
        rejectUnauthorized: true,
        timeout: TIMEOUT_MS,
        agent: freshAgent(),
        headers: {
          "Content-Type": "application/soap+xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(envelope),
        },
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          // A 302 here almost always means the mTLS cert was not presented or
          // the source IP is not adhered: SET bounces unauthenticated callers to
          // its portal instead of answering SOAP.
          res.resume();
          reject(new Error(`SIFEN HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(new Error("SIFEN response exceeded size cap"));
            return;
          }
          data += chunk;
        });
        res.on("end", () => resolve(data));
      },
    );

    const onAbort = () => req.destroy(new Error("SIFEN request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`SIFEN timeout after ${TIMEOUT_MS}ms`)));
    req.write(envelope);
    req.end();
  });
}

// ============================================================================
// Lote dispatch (siRecepLoteDE)
// ============================================================================

export type LoteSendResult = {
  // true means SET ACCEPTED the lote for processing (dCodRes 0300). It does NOT
  // mean the DEs inside were approved; that is resolved later by pollLote.
  accepted: boolean;
  responseCode: string;
  responseMessage: string;
  protocolNumber?: string;
  // dTpoProces: SET's estimate in seconds of how long the lote takes to process.
  // The poller uses it to schedule the first poll so it does not arrive early.
  processingSeconds?: number;
};

function buildLoteXml(signedDes: string[]): string {
  if (signedDes.length < 1 || signedDes.length > 50) {
    throw new Error(`A lote must hold 1..50 documents, got ${signedDes.length}`);
  }
  const inner = signedDes.map(stripProlog).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rLoteDE xmlns="${SIFEN_NS}">${inner}</rLoteDE>`;
}

// SET only accepts the lote as a ZIP, Base64-encoded (Manual v150 9.2). Not
// gzip, not plain XML. Max packed size is 1000 KB.
async function zipLoteBase64(loteXml: string): Promise<string> {
  const zip = new JSZip();
  zip.file("lote.xml", loteXml);
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (buf.byteLength > 1_000_000) {
    throw new Error(`Lote ZIP exceeds 1000 KB (${buf.byteLength} bytes). Send fewer documents.`);
  }
  return buf.toString("base64");
}

export async function sendLote(
  dispatchId: string,
  signedDes: string[],
  env: SifenEnv,
  mtls: SifenMtls,
  signal?: AbortSignal,
): Promise<LoteSendResult> {
  const loteXml = buildLoteXml(signedDes);
  const zipB64 = await zipLoteBase64(loteXml);

  if (isStubMode()) {
    return runStub.sendLote(dispatchId, signedDes.length);
  }

  const body =
    `<rEnvioLote xmlns="${SIFEN_NS}"><dId>${dispatchId}</dId>` +
    `<xDE>${zipB64}</xDE></rEnvioLote>`;

  logger.info("sifen.lote.send", { dispatchId, count: signedDes.length, env });
  const raw = await soapPost(`${ENDPOINTS[env]}async/recibe-lote.wsdl`, body, mtls, signal);
  return parseLoteSend(raw);
}

function parseLoteSend(raw: string): LoteSendResult {
  const parsed = parser.parse(raw);
  const result = parsed?.Envelope?.Body?.rResEnviLoteDe ?? {};
  const responseCode = String(result.dCodRes ?? "UNKNOWN");
  const protocolNumber = result.dProtConsLote ? String(result.dProtConsLote) : undefined;
  const dTpo = result.dTpoProces ? Number(result.dTpoProces) : undefined;
  return {
    accepted: responseCode === "0300" && Boolean(protocolNumber),
    responseCode,
    responseMessage: String(result.dMsgRes ?? "No message"),
    protocolNumber,
    processingSeconds: Number.isFinite(dTpo) ? dTpo : undefined,
  };
}

// ============================================================================
// Lote result polling (siResultLoteDE)
// ============================================================================

export type LoteEntry = {
  cdc: string;
  estado: string;
  approved: boolean;
  responseCode: string;
  responseMessage: string;
};

export type LoteResult = {
  // 0361 -> processing, 0362 -> processed (entries populated), 0360 -> not_found.
  state: "processing" | "processed" | "not_found" | "unknown";
  responseCode: string;
  responseMessage: string;
  entries: LoteEntry[];
};

// SET writes the literal estado in Spanish: 'Aprobado', 'Aprobado con
// observacion', 'Rechazado'. Any 'Aprobado' prefix counts as approved. The
// estado is the authoritative gate, never the response code alone.
export function isApprovedEstado(estado: string | undefined): boolean {
  return Boolean(estado) && estado!.trim().toLowerCase().startsWith("aprobado");
}

export async function pollLote(
  protocolNumber: string,
  env: SifenEnv,
  mtls: SifenMtls,
  signal?: AbortSignal,
): Promise<LoteResult> {
  if (isStubMode()) {
    return runStub.pollLote(protocolNumber);
  }

  const body =
    `<rEnviConsLoteDe xmlns="${SIFEN_NS}"><dId>${Date.now() % 1_000_000_000}</dId>` +
    `<dProtConsLote>${protocolNumber}</dProtConsLote></rEnviConsLoteDe>`;

  logger.info("sifen.lote.poll", { protocolNumber, env });
  const raw = await soapPost(`${ENDPOINTS[env]}consultas/consulta-lote.wsdl`, body, mtls, signal);
  return parseLoteResult(raw);
}

function parseLoteResult(raw: string): LoteResult {
  const parsed = parser.parse(raw);
  const result = parsed?.Envelope?.Body?.rResEnviConsLoteDe ?? {};
  const responseCode = String(result.dCodResLot ?? "UNKNOWN");

  let state: LoteResult["state"] = "unknown";
  if (responseCode === "0360") state = "not_found";
  else if (responseCode === "0361") state = "processing";
  else if (responseCode === "0362") state = "processed";

  const entries: LoteEntry[] = [];
  if (state === "processed") {
    const raw = result.gResProcLote;
    const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const row of rows) {
      const estado = String(row.dEstRes ?? "");
      const msgRaw = row.gResProc;
      const firstMsg = (Array.isArray(msgRaw) ? msgRaw[0] : msgRaw) ?? {};
      entries.push({
        cdc: String(row.id ?? ""),
        estado,
        approved: isApprovedEstado(estado),
        responseCode: String(firstMsg.dCodRes ?? ""),
        responseMessage: String(firstMsg.dMsgRes ?? ""),
      });
    }
  }

  return {
    state,
    responseCode,
    responseMessage: String(result.dMsgResLot ?? "No message"),
    entries,
  };
}

// ============================================================================
// Single DE consult by CDC (siConsDE): the fallback
// ============================================================================

export type ConsultResult = {
  // approved is derived ONLY from dEstRes, never from dCodRes. 0422 just means
  // "CDC found"; a Rejected or Cancelled DE also returns 0422.
  approved: boolean;
  responseCode: string;
  responseMessage: string;
  estado?: string;
};

export async function consultDe(
  cdc: string,
  env: SifenEnv,
  mtls: SifenMtls,
  signal?: AbortSignal,
): Promise<ConsultResult> {
  if (isStubMode()) {
    return runStub.consultDe(cdc);
  }

  const body =
    `<rEnviConsDeRequest xmlns="${SIFEN_NS}"><dId>${Date.now() % 1_000_000_000}</dId>` +
    `<dCDC>${cdc}</dCDC></rEnviConsDeRequest>`;

  logger.info("sifen.de.consult", { env });
  const raw = await soapPost(`${ENDPOINTS[env]}consultas/consulta.wsdl`, body, mtls, signal);
  return parseConsult(raw);
}

function parseConsult(raw: string): ConsultResult {
  const parsed = parser.parse(raw);
  const result =
    parsed?.Envelope?.Body?.rEnviConsDeResponse ??
    parsed?.Envelope?.Body?.rRetConsDe ??
    {};
  const prot = result.rProtDe ?? {};
  const gRes = prot.gResProc ?? result.gResProc ?? {};
  const estado = prot.dEstRes ? String(prot.dEstRes) : undefined;
  return {
    approved: isApprovedEstado(estado),
    responseCode: String(gRes.dCodRes ?? result.dCodRes ?? "UNKNOWN"),
    responseMessage: String(gRes.dMsgRes ?? result.dMsgRes ?? "No message"),
    estado,
  };
}
