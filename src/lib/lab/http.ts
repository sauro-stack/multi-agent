import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { scrubSecrets } from "@/lib/crypto";
import { SESSION_COOKIE, getSession } from "@/lib/lab/sessions";
import type { SessionPublic } from "@/lib/types";
import { ensureRuntime } from "@/lib/engine/runtime";

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("cache-control", "no-store, max-age=0");
  return response;
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return json({ error: scrubSecrets(message), ...extra }, { status });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24,
  };
}

export function readSession(request: NextRequest): { id: string | null; session: SessionPublic | null } {
  const id = request.cookies.get(SESSION_COOKIE)?.value ?? null;
  if (!id) return { id: null, session: null };
  return { id, session: getSession(id) };
}

export interface AuthedContext {
  sessionId: string;
  session: SessionPublic;
}

/**
 * Guard for routes that need a session. Also boots the scheduler so the lab
 * starts running the first time a browser touches the API.
 */
export function requireSession(request: NextRequest): AuthedContext | NextResponse {
  ensureRuntime();
  const { id, session } = readSession(request);
  if (!id || !session) {
    return fail("No active session. Create one from the setup screen.", 401);
  }
  return { sessionId: id, session };
}

export function isFailure(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/** Body reader that never throws on a malformed payload. */
export async function readJson<T>(request: NextRequest): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function parseBool(value: string | null): boolean {
  return value === "1" || value === "true";
}
