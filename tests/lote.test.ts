import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendLote, pollLote, consultDe, isApprovedEstado } from "@/lib/sifen/client";
import { runStub } from "@/lib/sifen/stub";

const EMPTY_MTLS = { certPem: "", privateKeyPem: "" };

function fakeSignedDe(cdc: string): string {
  return `<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><DE Id="${cdc}"></DE></rDE>`;
}

test("isApprovedEstado gates ONLY on the 'Aprobado' literal, never the code", () => {
  // This is the gate that stops a found-but-rejected DE (which still returns a
  // success-looking response code) from being booked as approved.
  assert.equal(isApprovedEstado("Aprobado"), true);
  assert.equal(isApprovedEstado("Aprobado con observacion"), true);
  assert.equal(isApprovedEstado("Rechazado"), false);
  assert.equal(isApprovedEstado("Cancelado"), false);
  assert.equal(isApprovedEstado(undefined), false);
});

test("sendLote (stub) accepts the lote and returns a protocol number", async () => {
  const cdc = "1".repeat(44);
  const result = await sendLote("100000000000001", [fakeSignedDe(cdc)], "test", EMPTY_MTLS);
  assert.equal(result.accepted, true);
  assert.equal(result.responseCode, "0300");
  assert.ok(result.protocolNumber);
});

test("a lote is 'processing' before its window, then 'processed' with approvals", async () => {
  const cdc = "2".repeat(44);
  const dispatchId = "100000000000002";
  const send = await sendLote(dispatchId, [fakeSignedDe(cdc)], "test", EMPTY_MTLS);
  const protocol = send.protocolNumber!;
  runStub.registerCdcs(protocol, [cdc]);

  // First poll lands inside the processing window: this is the path the poller's
  // exponential backoff exists for.
  const first = await pollLote(protocol, "test", EMPTY_MTLS);
  assert.equal(first.state, "processing");
  assert.equal(first.responseCode, "0361");
  assert.equal(first.entries.length, 0);

  // After the window, the lote is processed and returns one approved entry per CDC.
  await new Promise((r) => setTimeout(r, 1_700));
  const second = await pollLote(protocol, "test", EMPTY_MTLS);
  assert.equal(second.state, "processed");
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0]?.cdc, cdc);
  assert.equal(second.entries[0]?.approved, true);
});

test("polling an unknown protocol returns not_found (0360)", async () => {
  const result = await pollLote("999999999999999", "test", EMPTY_MTLS);
  assert.equal(result.state, "not_found");
  assert.equal(result.responseCode, "0360");
});

test("consultDe (stub) resolves a CDC to approved via dEstRes", async () => {
  const result = await consultDe("3".repeat(44), "test", EMPTY_MTLS);
  assert.equal(result.approved, true);
  assert.equal(result.estado, "Aprobado");
});

test("a lote enforces the 1..50 size bound", async () => {
  await assert.rejects(
    () => sendLote("1", [], "test", EMPTY_MTLS),
    /1\.\.50/,
  );
  const tooMany = Array.from({ length: 51 }, (_, i) => fakeSignedDe(String(i).padStart(44, "0")));
  await assert.rejects(() => sendLote("1", tooMany, "test", EMPTY_MTLS), /1\.\.50/);
});
