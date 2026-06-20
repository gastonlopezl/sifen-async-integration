import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidRucDv,
  assertValidRucDv,
  assertTimbradoActive,
  assertValidCdc,
} from "@/lib/sifen/guards";
import type { Issuer } from "@/lib/sifen/issuer";

const baseIssuer: Issuer = {
  ruc: "80017556",
  dv: 5,
  timbrado: "12345678",
  timbradoStart: "2026-01-01",
  timbradoEnd: "2026-12-31",
  establishment: "001",
  expeditionPoint: "001",
  env: "test",
};

test("RUC Modulo 11 check digit validates a known-good pair", () => {
  assert.equal(isValidRucDv("80017556", 5), true);
});

test("RUC check digit rejects the wrong DV", () => {
  assert.equal(isValidRucDv("80017556", 4), false);
  assert.throws(() => assertValidRucDv("80017556", 4), /Invalid RUC check digit/);
});

test("RUC check digit rejects a non-numeric RUC and an out-of-range DV", () => {
  assert.equal(isValidRucDv("8001AB56", 5), false);
  assert.equal(isValidRucDv("80017556", 10), false);
});

test("timbrado guard passes inside the window", () => {
  assert.doesNotThrow(() => assertTimbradoActive(baseIssuer, new Date("2026-06-15")));
});

test("timbrado guard rejects a not-yet-active timbrado", () => {
  assert.throws(
    () => assertTimbradoActive(baseIssuer, new Date("2025-12-31")),
    /not active yet/,
  );
});

test("timbrado guard rejects an expired timbrado", () => {
  assert.throws(
    () => assertTimbradoActive(baseIssuer, new Date("2027-01-01")),
    /expired/,
  );
});

test("CDC guard requires exactly 44 digits", () => {
  assert.throws(() => assertValidCdc("123"), /44 digits/);
  assert.throws(() => assertValidCdc("0".repeat(43)), /44 digits/);
  assert.throws(() => assertValidCdc("x".repeat(44)), /44 digits/);
  assert.doesNotThrow(() => assertValidCdc("0".repeat(44)));
});
