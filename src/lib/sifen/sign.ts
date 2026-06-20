import { createHash, createSign } from "node:crypto";
import { env, isStubMode } from "@/lib/env";

// Enveloped XML signature over the DE.
//
// SIFEN requires an XML-DSig enveloped signature whose Reference URI is "#{cdc}"
// (the DE element's Id). A full XML-DSig implementation needs exclusive C14N over
// the referenced node; production code uses a vetted library (xml-crypto) for
// that. Here we implement the signature shape and the cryptography directly so
// the flow is self-contained and the structure is visible: digest the DE node,
// build the SignedInfo, RSA-SHA256 sign it, and append the ds:Signature inside
// the <DE>.
//
// stub mode produces a deterministic placeholder signature so the entire enqueue
// -> dispatch -> poll flow runs with no certificate. The dispatch_key (a sha256
// of xml_signed) stays stable across runs, which is exactly what the idempotency
// test relies on.
//
// WARNING for anyone hardening this for production: real SET acceptance requires
// canonicalizing the referenced node with Exclusive XML Canonicalization (C14N)
// before digesting, and including the X509Certificate in KeyInfo. Swap this for
// xml-crypto with c14n once you have a SET-adhered IP to test against.

const DS = "http://www.w3.org/2000/09/xmldsig#";

function digestNode(node: string): string {
  return createHash("sha256").update(node, "utf8").digest("base64");
}

function buildSignedInfo(cdc: string, digest: string): string {
  return (
    `<SignedInfo xmlns="${DS}">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<Reference URI="#${cdc}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`
  );
}

function signSignedInfo(signedInfo: string): string {
  if (isStubMode()) {
    // Deterministic placeholder: a hash of the SignedInfo, base64'd. Stable per
    // input so xml_signed (and therefore the dispatch_key) is reproducible.
    return createHash("sha256").update(signedInfo, "utf8").digest("base64");
  }
  const signer = createSign("RSA-SHA256");
  signer.update(signedInfo, "utf8");
  return signer.sign(env.SIFEN_PRIVATE_KEY_PEM, "base64");
}

function certificateBody(): string {
  if (isStubMode()) return "STUBCERT";
  return env.SIFEN_CERT_PEM
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

// Sign an unsigned <rDE>...<DE Id="{cdc}">...</DE></rDE>, returning the signed
// XML with the ds:Signature appended inside the DE. The CDC is the DE Id, so the
// signature reference resolves to the document body.
export function signDe(unsignedRde: string, cdc: string): string {
  // The signature covers the DE element, which we approximate here by digesting
  // the serialized DE node. Production C14N would canonicalize first.
  const deMatch = unsignedRde.match(/<DE Id="[^"]+">[\s\S]*<\/DE>/);
  if (!deMatch) throw new Error("Unsigned rDE does not contain a DE element");
  const deNode = deMatch[0];

  const digest = digestNode(deNode);
  const signedInfo = buildSignedInfo(cdc, digest);
  const signatureValue = signSignedInfo(signedInfo);

  const signature =
    `<Signature xmlns="${DS}">` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certificateBody()}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  // Inject the signature just before </DE>, the enveloped position SET expects.
  return unsignedRde.replace("</DE>", `${signature}</DE>`);
}
