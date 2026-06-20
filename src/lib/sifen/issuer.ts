import { env } from "@/lib/env";

// The issuer (emisor) identity. In a multi-tenant invoicing product each store
// has its own RUC, timbrado, and certificate, loaded from the database per
// document. Here it comes from env so the demo runs as a single issuer, but the
// shape is the contract every downstream function consumes.
export type Issuer = {
  ruc: string;
  dv: number;
  timbrado: string;
  timbradoStart: string;
  timbradoEnd: string;
  establishment: string;
  expeditionPoint: string;
  env: "test" | "prod";
};

export function loadIssuer(): Issuer {
  return {
    ruc: env.ISSUER_RUC,
    dv: env.ISSUER_DV,
    timbrado: env.ISSUER_TIMBRADO,
    timbradoStart: env.ISSUER_TIMBRADO_START,
    timbradoEnd: env.ISSUER_TIMBRADO_END,
    establishment: env.ISSUER_ESTABLISHMENT,
    expeditionPoint: env.ISSUER_EXPEDITION_POINT,
    env: env.SIFEN_ENV,
  };
}
