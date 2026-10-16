import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { announce } from "@/lib/engine/agent-loop";
import { ensureRuntime, fanOutRoom, runtimeStatus } from "@/lib/engine/runtime";
import { buildDiscoveryGraph } from "@/lib/discovery";
import { fail, isFailure, json, readJson, requireSession } from "@/lib/lab/http";
import { getRoom, listAgents, listLogEntries, updateRoom } from "@/lib/lab/store";
import { GRAPH_KINDS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  ensureRuntime();
  const { roomId } = await context.params;

  const room = getRoom(roomId);
  if (!room) return fail("Room not found", 404);

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 150) || 150, 500);

  return json({
    room,
    agents: listAgents(roomId),
    entries: listLogEntries(roomId, { limit }),
    graph: buildDiscoveryGraph(listLogEntries(roomId, { limit: 240, kinds: GRAPH_KINDS })),
    runtime: runtimeStatus(),
  });
}

const patchSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = requireSession(request);
  if (isFailure(auth)) return auth;

  const { roomId } = await context.params;
  const room = getRoom(roomId);
  if (!room) return fail("Room not found", 404);

  const body = await readJson<unknown>(request);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail("status must be ACTIVE | PAUSED | ARCHIVED", 422);

  const updated = updateRoom(roomId, { status: parsed.data.status });
  if (!updated) return fail("Room update failed", 500);

  announce({
    roomId,
    agentId: null,
    agentName: auth.session.agentName,
    provider: null,
    title: `Room set to ${updated.status}`,
    content:
      updated.status === "ACTIVE"
        ? `${auth.session.agentName} resumed the room. Idle agents are being fanned out again.`
        : `${auth.session.agentName} paused the room. No new cycles will be scheduled until it is resumed.`,
    metadata: { kind: "room_status", status: updated.status },
  });

  const resumed = updated.status === "ACTIVE" ? fanOutRoom(roomId) : 0;

  return json({ room: updated, resumed });
}
