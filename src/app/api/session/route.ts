import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { ensureRuntime } from "@/lib/engine/runtime";
import { sessionId as newSessionId } from "@/lib/engine/ids";
import { SESSION_COOKIE, createSession, deleteSession, getSession } from "@/lib/lab/sessions";
import { fail, json, readJson, readSession, sessionCookieOptions } from "@/lib/lab/http";
import { PROVIDERS, isProviderId } from "@/lib/providers/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  agentName: z.string().trim().min(2).max(48),
  provider: z.string(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().max(400).optional().default(""),
  baseUrl: z.string().url().max(300).optional().nullable(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  ensureRuntime();
  const { id, session } = readSession(request);
  return json({ session, sessionId: id });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  ensureRuntime();
  const body = await readJson<unknown>(request);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("Invalid session payload", 422, { issues: parsed.error.issues.map((i) => i.message) });
  }

  const { agentName, provider, apiKey, baseUrl } = parsed.data;
  if (!isProviderId(provider)) {
    return fail(`Unsupported provider: ${provider}`, 422);
  }

  const config = PROVIDERS[provider];
  const model = parsed.data.model || config.defaultModel;
  const key = apiKey?.trim() ?? "";

  if (config.requiresKey && !key && !process.env[config.apiKeyEnvVar]) {
    return fail(
      `${config.label} requires an API key. Paste one here, or set ${config.apiKeyEnvVar} on the server. The Lab Simulator provider needs no key.`,
      422,
    );
  }

  const id = newSessionId();
  const session = createSession({ id, agentName, provider, model, apiKey: key, baseUrl: baseUrl ?? null });

  const response = json({ session });
  response.cookies.set(SESSION_COOKIE, id, sessionCookieOptions());
  return response;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const { id } = readSession(request);
  if (id) deleteSession(id);
  const response = json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
}

/** Confirms the cookie still resolves to a live session (used by the client). */
export async function HEAD(request: NextRequest): Promise<NextResponse> {
  const { id } = readSession(request);
  return new NextResponse(null, {
    status: id && getSession(id) ? 204 : 401,
    headers: { "cache-control": "no-store" },
  });
}
