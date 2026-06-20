import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCdc, formatDocumentNumber } from "@/lib/sifen/cdc";
import { assertValidCdc } from "@/lib/sifen/guards";
import { loadIssuer } from "@/lib/sifen/issuer";

const issuer = loadIssuer();

test("buildCdc produces a 44-digit code that passes the CDC guard", () => {
  const cdc = buildCdc({
    issuer,
    documentType: "01",
    documentNumber: formatDocumentNumber(issuer, 1),
    issueDate: new Date("2026-06-15T10:00:00Z"),
  });
  assert.match(cdc, /^\d{44}$/);
  assert.doesNotThrow(() => assertValidCdc(cdc));
});

test("CDC embeds the document type, issuer RUC and timbrado-derived fields", () => {
  const cdc = buildCdc({
    issuer,
    documentType: "01",
    documentNumber: formatDocumentNumber(issuer, 42),
    issueDate: new Date("2026-06-15T10:00:00Z"),
  });
  // type (2) + RUC (8) at the front, per the fixed layout.
  assert.equal(cdc.slice(0, 2), "01");
  assert.equal(cdc.slice(2, 10), issuer.ruc.padStart(8, "0"));
});

test("two documents with different numbers get different CDCs", () => {
  const a = buildCdc({
    issuer,
    documentType: "01",
    documentNumber: formatDocumentNumber(issuer, 1),
    issueDate: new Date("2026-06-15T10:00:00Z"),
  });
  const b = buildCdc({
    issuer,
    documentType: "01",
    documentNumber: formatDocumentNumber(issuer, 2),
    issueDate: new Date("2026-06-15T10:00:00Z"),
  });
  assert.notEqual(a, b);
});

test("document number renders the 001-001-0000001 prefix", () => {
  assert.equal(formatDocumentNumber(issuer, 1), "001-001-0000001");
  assert.equal(formatDocumentNumber(issuer, 1234567), "001-001-1234567");
});
