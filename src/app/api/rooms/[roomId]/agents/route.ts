import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { announce, startAgent } from "@/lib/engine/agent-loop";
import { agentId as newAgentId } from "@/lib/engine/ids";
import { fail, isFailure, json, readJson, requireSession } from "@/lib/lab/http";
import { countAgentsInRoom, createAgent, getRoom, listAgents } from "@/lib/lab/store";
import { PROVIDERS, isProviderId } from "@/lib/providers/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const joinSchema = z.object({
  name: z.string().trim().min(2).max(48).optional(),
  provider: z.string().optional(),
  model: z.string().trim().min(1).max(120).optional(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const { roomId } = await context.params;
  if (!getRoom(roomId)) return fail("Room not found", 404);
  return json({ agents: listAgents(roomId) });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const auth = requireSession(request);
  if (isFailure(auth)) return auth;

  const { roomId } = await context.params;
  const room = getRoom(roomId);
  if (!room) return fail("Room not found", 404);
  if (room.status !== "ACTIVE") return fail(`Room is ${room.status}; no new agents can join.`, 409);

  const body = await readJson<unknown>(request);
  const parsed = joinSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("Invalid join payload", 422, { issues: parsed.error.issues.map((i) => i.message) });
  }

  const requestedProvider = parsed.data.provider ?? auth.session.provider;
  if (!isProviderId(requestedProvider)) return fail(`Unsupported provider: ${requestedProvider}`, 422);

  const existing = listAgents(roomId);
  if (existing.length >= room.maxAgents) {
    return fail(`Room is full (${existing.length}/${room.maxAgents} agents).`, 409, {
      maxAgents: room.maxAgents,
    });
  }

  const baseName = parsed.data.name ?? auth.session.agentName;
  let name = baseName;
  let suffix = 2;
  while (existing.some((agent) => agent.name === name)) {
    name = `${baseName} ${suffix}`;
    suffix += 1;
  }

  const config = PROVIDERS[requestedProvider];
  const agent = createAgent({
    id: newAgentId(),
    roomId,
    sessionId: auth.sessionId,
    name,
    provider: requestedProvider,
    model: parsed.data.model ?? (requestedProvider === auth.session.provider ? auth.session.model : config.defaultModel),
  });

  announce({
    roomId,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    title: `${agent.name} joined the room`,
    content: `${agent.name} registered with **${config.label}** (\`${agent.model}\`) and is starting its first autonomous cycle.`,
    metadata: { kind: "agent_joined" },
  });

  startAgent(agent.id);

  return json({ agent }, { status: 201 });
}
