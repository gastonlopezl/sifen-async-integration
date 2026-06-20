import { NextResponse } from "next/server";
import { z } from "zod";
import { findStatusByCdc } from "@/lib/db/documents";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ cdc: z.string().regex(/^\d{44}$/) });

// Read the current SIFEN status of a document by its CDC. Projects to an explicit
// DTO: the raw row carries the signed XML and internal dispatch/poll bookkeeping
// that a client has no business seeing, so we never return it directly.
export async function GET(req: Request): Promise<NextResponse> {
  if (!rateLimit(`status:${clientIp(req)}`, 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({ cdc: searchParams.get("cdc") });
  if (!parsed.success) {
    return NextResponse.json({ error: "cdc must be 44 digits" }, { status: 400 });
  }

  const doc = await findStatusByCdc(parsed.data.cdc);
  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    cdc: doc.cdc,
    documentNumber: doc.document_number,
    status: doc.sifen_status,
    protocolNumber: doc.protocol_number,
    responseCode: doc.response_code,
    responseMessage: doc.response_message,
    approvedAt: doc.approved_at,
  });
}
