import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { fanOutRoom, runtimeStatus } from "@/lib/engine/runtime";
import { DEMO_PRESETS, seedDemoRoom } from "@/lib/lab/demo";
import { fail, isFailure, json, readJson, requireSession } from "@/lib/lab/http";
import { listRooms } from "@/lib/lab/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  presetSlug: z.string().trim().max(60).optional(),
  topic: z.string().trim().max(200).optional(),
  objective: z.string().trim().max(600).optional(),
  /** Reuse an existing room with the same topic instead of creating a new one. */
  rejoin: z.boolean().optional().default(true),
  /** Keep the caller out of the swarm (spectator mode). */
  spectator: z.boolean().optional().default(false),
});

/**
 * Seeds a trio of simulator agents so the full loop — including throttling and
 * scheduled resumes — is observable with no provider credentials.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = requireSession(request);
  if (isFailure(auth)) return auth;

  const body = await readJson<unknown>(request);
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) return fail("Invalid demo payload", 422);

  const preset =
    DEMO_PRESETS.find((p) => p.slug === parsed.data.presetSlug) ?? DEMO_PRESETS[0];
  const topic = parsed.data.topic?.trim() || preset.topic;

  const existing =
    parsed.data.rejoin !== false ? listRooms(50).find((room) => room.topic === topic) ?? null : null;

  const result = seedDemoRoom({
    presetSlug: parsed.data.presetSlug,
    topic,
    objective: parsed.data.objective,
    createdBy: auth.session.agentName,
    issuerSessionId: auth.sessionId,
    issuerProvider: auth.session.provider,
    issuerModel: auth.session.model,
    includeIssuer: !parsed.data.spectator,
    rejoined: existing,
  });

  const resumed = fanOutRoom(result.room.id);

  return json(
    {
      room: result.room,
      agents: result.agents,
      reused: Boolean(existing),
      resumed,
      runtime: runtimeStatus(),
    },
    { status: existing ? 200 : 201 },
  );
}

export async function GET(): Promise<NextResponse> {
  return json({
    presets: DEMO_PRESETS,
    rooms: listRooms(20),
    runtime: runtimeStatus(),
  });
}
