import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { announce, pauseAgent, resumeAgent } from "@/lib/engine/agent-loop";
import { fail, isFailure, json, readJson, requireSession } from "@/lib/lab/http";
import { getAgent, listJobsForAgent, removeAgent } from "@/lib/lab/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  action: z.enum(["resume", "pause", "remove"]),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const { agentId } = await context.params;
  const agent = getAgent(agentId);
  if (!agent) return fail("Agent not found", 404);
  return json({ agent, jobs: listJobsForAgent(agentId) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
  const auth = requireSession(request);
  if (isFailure(auth)) return auth;

  const { agentId } = await context.params;
  const agent = getAgent(agentId);
  if (!agent) return fail("Agent not found", 404);

  const body = await readJson<unknown>(request);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail("action must be one of resume | pause | remove", 422);

  switch (parsed.data.action) {
    case "resume": {
      // A human asked for this, so the throttle streak resets and the agent
      // gets a fresh set of backoff attempts.
      const result = resumeAgent(agentId, { manual: true });
      return json({ agent: getAgent(agentId), ...result });
    }
    case "pause": {
      const updated = pauseAgent(agent);
      announce({
        roomId: agent.roomId,
        agentId: agent.id,
        agentName: agent.name,
        provider: agent.provider,
        title: `${agent.name} manually paused`,
        content: `Paused by ${auth.session.agentName}. No further cycles will be scheduled until it is resumed.`,
        metadata: { kind: "manual_pause" },
      });
      return json({ agent: updated, paused: true });
    }
    case "remove": {
      announce({
        roomId: agent.roomId,
        agentId: null,
        agentName: auth.session.agentName,
        provider: null,
        title: `${agent.name} left the room`,
        content: `Removed after ${agent.contributions} contributions across ${agent.iteration} cycles.`,
        metadata: { kind: "agent_removed" },
      });
      removeAgent(agentId);
      return json({ removed: true, agentId });
    }
    default:
      return fail("Unsupported action", 422);
  }
}
