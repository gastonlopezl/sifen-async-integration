import { NextResponse } from "next/server";
import { z } from "zod";
import { enqueueDocument } from "@/lib/sifen/enqueue";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  documentType: z.enum(["01", "04", "05", "06", "07"]).default("01"),
  customerRuc: z.string().regex(/^\d+-?\d?$/),
  customerName: z.string().min(1).max(255),
  // PYG, integer-ish but accept a 2-decimal amount. Positive, capped to a sane
  // per-document maximum to reject a fat-fingered request before it becomes a DE.
  totalPyg: z.number().positive().max(9_999_999_999),
});

// Enqueue a document for SIFEN emission. This returns in milliseconds with the
// CDC and an id: it builds and signs the DE and puts it on the queue, then hands
// off to the worker. It NEVER calls SET inline. That is the architecture, not an
// optimization: SET emission is async by policy (the sync receive is refused in
// prod), and even if it were not, blocking an HTTP request on SET's processing
// clock would time out under load.
export async function POST(req: Request): Promise<NextResponse> {
  if (!rateLimit(`enqueue:${clientIp(req)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? z.prettifyError(error) : "Invalid body" },
      { status: 400 },
    );
  }

  try {
    const result = await enqueueDocument(parsed);
    logger.info("enqueue.ok", { id: result.id, status: result.status });
    return NextResponse.json(result, { status: 202 });
  } catch (error: unknown) {
    // The guards throw readable domain errors (bad RUC DV, expired timbrado).
    // Surface the message to the caller; it is actionable and carries no secret.
    const message = error instanceof Error ? error.message : "Enqueue failed";
    logger.warn("enqueue.rejected", { reason: message });
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
