import type { Issuer } from "./issuer";

// Composable assertions that run BEFORE any XML is built. The point is to fail
// with a precise, actionable message at enqueue time instead of letting SET
// reject the document later with an opaque code. Each guard throws a plain Error
// the route layer sanitizes before it reaches a client.

// Paraguay RUC check digit, Modulo 11. DNIT publishes this as the official
// validation for a RUC + DV pair. We enforce it so an invalid RUC never reaches
// the CDC builder (which would otherwise bake a wrong check digit into the
// 44-digit code and get the whole document rejected downstream).
export function isValidRucDv(ruc: string, dv: number): boolean {
  if (!/^\d+$/.test(ruc)) return false;
  if (!Number.isInteger(dv) || dv < 0 || dv > 9) return false;

  let total = 0;
  let factor = 2;
  for (let i = ruc.length - 1; i >= 0; i--) {
    total += Number(ruc[i]) * factor;
    factor = factor > 10 ? 2 : factor + 1;
  }
  const remainder = total % 11;
  const expected = remainder > 1 ? 11 - remainder : 0;
  return expected === dv;
}

export function assertValidRucDv(ruc: string, dv: number): void {
  if (!isValidRucDv(ruc, dv)) {
    throw new Error(`Invalid RUC check digit for ${ruc}-${dv}`);
  }
}

// A timbrado is out of range in two ways: not yet active (start in the future)
// or expired (end in the past). SET rejects both. We compare on the date only,
// in the issuer's local calendar day, because the timbrado window is a date
// range, not a timestamp.
export function assertTimbradoActive(issuer: Issuer, on: Date = new Date()): void {
  const today = on.toISOString().slice(0, 10);
  if (issuer.timbradoStart > today) {
    throw new Error(
      `Timbrado ${issuer.timbrado} is not active yet (starts ${issuer.timbradoStart})`,
    );
  }
  if (issuer.timbradoEnd < today) {
    throw new Error(
      `Timbrado ${issuer.timbrado} expired on ${issuer.timbradoEnd}`,
    );
  }
}

// The CDC is exactly 44 digits. Anything else is rejected before egress: SET
// validates the structure and a malformed CDC poisons the whole lote.
export function assertValidCdc(cdc: string): void {
  if (!/^\d{44}$/.test(cdc)) {
    throw new Error("Invalid CDC: must be exactly 44 digits");
  }
}
