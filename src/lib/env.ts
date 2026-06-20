import { z } from "zod";

const schema = z.object({
  SIFEN_ENV: z.enum(["test", "prod"]).default("test"),
  SIFEN_MODE: z.enum(["stub", "live"]).default("stub"),
  ISSUER_RUC: z.string().regex(/^\d{1,8}$/),
  ISSUER_DV: z.coerce.number().int().min(0).max(9),
  ISSUER_TIMBRADO: z.string().regex(/^\d{8}$/),
  ISSUER_TIMBRADO_START: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ISSUER_TIMBRADO_END: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ISSUER_ESTABLISHMENT: z.string().regex(/^\d{3}$/),
  ISSUER_EXPEDITION_POINT: z.string().regex(/^\d{3}$/),
  SIFEN_CERT_PEM: z.string().default(""),
  SIFEN_PRIVATE_KEY_PEM: z.string().default(""),
  SIFEN_ENCRYPTION_KEY: z.string().default(""),
  DATABASE_URL: z.string().min(1),
  SIFEN_AUTO_DISPATCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

type Env = z.infer<typeof schema>;

let cached: Env | null = null;

function load(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  }

  // In live mode the certificate material is mandatory. We assert it here so a
  // misconfigured deploy fails on boot with a precise message, instead of dying
  // at TLS handshake time with SET's opaque 302-to-portal redirect.
  if (parsed.data.SIFEN_MODE === "live") {
    if (!parsed.data.SIFEN_CERT_PEM || !parsed.data.SIFEN_PRIVATE_KEY_PEM) {
      throw new Error(
        "SIFEN_MODE=live requires SIFEN_CERT_PEM and SIFEN_PRIVATE_KEY_PEM",
      );
    }
  }

  cached = parsed.data;
  return cached;
}

// Lazy proxy: validation runs on first property access (request/worker boot),
// not at import. `next build` can evaluate route modules without the runtime
// secrets present, while the first real use on a misconfigured deploy throws
// immediately with a readable message.
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return load()[prop as keyof Env];
  },
});

export const isStubMode = (): boolean => env.SIFEN_MODE === "stub";
