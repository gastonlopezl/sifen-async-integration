import { env, isStubMode } from "@/lib/env";
import type { SifenMtls } from "./client";

// Load the mTLS material (certificate + private key PEMs) the SOAP client needs.
//
// In a multi-tenant product this reads the issuer's cert from the database and
// decrypts the private key with the AES-256-GCM key held only by the worker, in
// memory, per call. The .p12 the merchant uploaded and its password are never
// persisted: at upload time the private key is extracted, encrypted, and stored,
// and the .p12 is discarded. That zero-password model is why the decrypt happens
// here and not at rest.
//
// In stub mode there is no certificate at all, so this returns empty PEMs and
// the client never reaches the TLS path.
export function loadCertificate(): SifenMtls {
  if (isStubMode()) {
    return { certPem: "", privateKeyPem: "" };
  }
  return {
    certPem: env.SIFEN_CERT_PEM,
    privateKeyPem: env.SIFEN_PRIVATE_KEY_PEM,
  };
}
