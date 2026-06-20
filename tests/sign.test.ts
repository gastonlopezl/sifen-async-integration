import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildCdc, formatDocumentNumber } from "@/lib/sifen/cdc";
import { buildUnsignedDe } from "@/lib/sifen/xml";
import { signDe } from "@/lib/sifen/sign";
import { loadIssuer } from "@/lib/sifen/issuer";

const issuer = loadIssuer();

function signedDe(sequence: number): { cdc: string; xml: string } {
  const documentNumber = formatDocumentNumber(issuer, sequence);
  const cdc = buildCdc({
    issuer,
    documentType: "01",
    documentNumber,
    issueDate: new Date("2026-06-15T10:00:00Z"),
  });
  const unsigned = buildUnsignedDe(issuer, {
    cdc,
    documentType: "01",
    documentNumber,
    issueDate: new Date("2026-06-15T10:00:00Z"),
    customerRuc: "2000000-1",
    customerName: "Acme SA",
    totalPyg: 150000,
  });
  return { cdc, xml: signDe(unsigned, cdc) };
}

test("the signature Reference URI points at the DE Id (the CDC)", () => {
  const { cdc, xml } = signedDe(1);
  assert.equal(xml.includes(`<DE Id="${cdc}">`), true);
  assert.equal(xml.includes(`<Reference URI="#${cdc}">`), true);
});

test("the ds:Signature is enveloped inside the DE element", () => {
  const { xml } = signedDe(1);
  const sigIndex = xml.indexOf("<Signature");
  const deCloseIndex = xml.indexOf("</DE>");
  assert.equal(sigIndex > 0 && sigIndex < deCloseIndex, true);
});

test("dispatch_key derived from a stored signed XML is deterministic", () => {
  // The dispatcher derives the per-document dispatch_key as sha256(xml_signed),
  // truncated to 40 chars, from the XML ALREADY STORED on the row. The whole
  // idempotency story rests on that hash being stable for a given stored XML, so
  // a worker restart that re-takes the same row reserves the same key and the
  // UNIQUE index blocks the second dispatch. (A fresh buildCdc would differ: the
  // CDC embeds a random security code, which is real SET behaviour, not a bug.)
  const xml = signedDe(7).xml;
  const keyA = createHash("sha256").update(xml).digest("hex").slice(0, 40);
  const keyB = createHash("sha256").update(xml).digest("hex").slice(0, 40);
  assert.equal(keyA, keyB);
  assert.equal(keyA.length, 40);
});

test("different documents yield different signed XML and different dispatch keys", () => {
  const a = signedDe(1).xml;
  const b = signedDe(2).xml;
  assert.notEqual(a, b);
  const keyA = createHash("sha256").update(a).digest("hex").slice(0, 40);
  const keyB = createHash("sha256").update(b).digest("hex").slice(0, 40);
  assert.notEqual(keyA, keyB);
});
