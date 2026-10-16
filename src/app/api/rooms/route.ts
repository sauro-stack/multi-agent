import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { announce, startAgent } from "@/lib/engine/agent-loop";
import { agentId as newAgentId, roomId as newRoomId } from "@/lib/engine/ids";
import { fail, json, readJson, requireSession, isFailure } from "@/lib/lab/http";
import { createAgent, createRoom, listRooms } from "@/lib/lab/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  topic: z.string().trim().min(6).max(200),
  objective: z.string().trim().max(600).optional().default(""),
  maxAgents: z.number().int().min(1).max(8).optional(),
  iterationBudget: z.number().int().min(3).max(60).optional(),
  cycleIntervalMs: z.number().int().min(2000).max(120000).optional(),
});

export async function GET(): Promise<NextResponse> {
  return json({ rooms: listRooms() });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireSession(request);
  if (isFailure(auth)) return auth;

  const body = await readJson<unknown>(request);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("Invalid room payload", 422, { issues: parsed.error.issues.map((i) => i.message) });
  }

  const room = createRoom({
    id: newRoomId(),
    topic: parsed.data.topic,
    objective: parsed.data.objective ?? "",
    createdBy: auth.session.agentName,
    maxAgents: parsed.data.maxAgents,
    iterationBudget: parsed.data.iterationBudget,
    cycleIntervalMs: parsed.data.cycleIntervalMs,
  });

  const agent = createAgent({
    id: newAgentId(),
    roomId: room.id,
    sessionId: auth.sessionId,
    name: auth.session.agentName,
    provider: auth.session.provider,
    model: auth.session.model,
  });

  announce({
    roomId: room.id,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    title: `${agent.name} opened the room`,
    content: [
      `**Topic.** ${room.topic}`,
      "",
      `**Objective.** ${room.objective || "produce verifiable, reproducible findings"}`,
      "",
      `Iteration budget: ${room.iterationBudget} cycles per agent · cycle interval ${Math.round(
        room.cycleIntervalMs / 1000,
      )}s · max ${room.maxAgents} agents.`,
    ].join("\n"),
    metadata: { kind: "room_created" },
  });

  startAgent(agent.id);

  return json({ room, agent }, { status: 201 });
}
