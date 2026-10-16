import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { fanOutAllRooms, fanOutRoom, runtimeStatus, tickOnce } from "@/lib/engine/runtime";
import { fail, json, readJson } from "@/lib/lab/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  await: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(32).optional(),
  fanOut: z.boolean().optional().default(false),
  roomId: z.string().trim().max(80).optional(),
});

/**
 * `POST /api/tick`
 *
 * The serverless-shaped entry point: a cron or an external worker calls this to
 * claim due jobs. With `LAB_RUNTIME=inline` (the default) the same work is done
 * by the in-process timer, and this endpoint is just a manual nudge.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readJson<unknown>(request);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return fail("Invalid tick payload", 422);

  const fanned = parsed.data.fanOut
    ? parsed.data.roomId
      ? fanOutRoom(parsed.data.roomId)
      : fanOutAllRooms()
    : 0;

  const summary = await tickOnce({ awaitJobs: parsed.data.await, limit: parsed.data.limit });

  return json({ ...summary, fannedOut: fanned, runtime: runtimeStatus() });
}

export async function GET(): Promise<NextResponse> {
  return json({ runtime: runtimeStatus() });
}
