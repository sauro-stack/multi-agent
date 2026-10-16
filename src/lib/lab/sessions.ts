import "server-only";

import { eq } from "drizzle-orm";

import { decryptSecret, encryptSecret, keyHint, scrubSecrets } from "@/lib/crypto";
import { getDb, schema } from "@/lib/db/client";
import { providerConfig } from "@/lib/providers/config";
import { ProviderError } from "@/lib/providers/errors";
import type { ProviderId, SessionPublic } from "@/lib/types";

import type { SessionRow } from "@/lib/db/schema";

export const SESSION_COOKIE = "arl_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function mapSession(row: SessionRow): SessionPublic {
  return {
    id: row.id,
    agentName: row.agentName,
    provider: row.provider as ProviderId,
    model: row.model,
    hasKey: Boolean(row.encryptedKey),
    keyHint: row.keyHint,
    keySource: row.keySource as SessionPublic["keySource"],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function createSession(input: {
  id: string;
  agentName: string;
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  ttlMs?: number;
}): SessionPublic {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? SESSION_TTL_MS));
  const trimmedKey = input.apiKey.trim();

  db.insert(schema.sessions)
    .values({
      id: input.id,
      agentName: input.agentName,
      provider: input.provider,
      model: input.model,
      // The plaintext key exists only inside this function and inside the
      // authenticated agent cycle that decrypts it. It is never returned.
      encryptedKey: trimmedKey ? encryptSecret(trimmedKey) : null,
      keyHint: trimmedKey ? keyHint(trimmedKey) : null,
      keySource: trimmedKey ? "session" : providerConfig(input.provider).requiresKey ? "session" : "simulated",
      baseUrl: input.baseUrl ?? null,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    })
    .run();

  return mapSession(getSessionRow(input.id) as SessionRow);
}

export function getSessionRow(id: string): SessionRow | null {
  const row = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    getDb().delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
    return null;
  }
  return row;
}

export function getSession(id: string): SessionPublic | null {
  const row = getSessionRow(id);
  return row ? mapSession(row) : null;
}

export function touchSession(id: string): void {
  getDb()
    .update(schema.sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function deleteSession(id: string): void {
  getDb().delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
}

export interface ResolvedCredential {
  apiKey: string;
  source: SessionPublic["keySource"];
  baseUrl: string | null;
  model: string;
  provider: ProviderId;
}

/**
 * Turns an agent identity into something callable.
 *
 * Resolution order: the encrypted session key, then a server-side environment
 * variable (useful for shared/demo deployments), then the offline simulator.
 * The returned `apiKey` must never leave the server.
 */
export function resolveCredential(agent: {
  provider: ProviderId;
  model: string;
  sessionId: string | null;
}): ResolvedCredential {
  const config = providerConfig(agent.provider);
  const session = agent.sessionId ? getSessionRow(agent.sessionId) : null;

  if (session?.encryptedKey) {
    try {
      return {
        apiKey: decryptSecret(session.encryptedKey),
        source: "session",
        baseUrl: session.baseUrl,
        model: agent.model || session.model,
        provider: agent.provider,
      };
    } catch (error) {
      throw new ProviderError({
        provider: agent.provider,
        status: 401,
        message: `Stored credential could not be decrypted: ${scrubSecrets(String(error))}. Re-create the session.`,
        retryable: false,
      });
    }
  }

  const fromEnv = process.env[config.apiKeyEnvVar];
  if (fromEnv) {
    return {
      apiKey: fromEnv,
      source: "server-env",
      baseUrl: null,
      model: agent.model || config.defaultModel,
      provider: agent.provider,
    };
  }

  if (!config.requiresKey) {
    return {
      apiKey: "",
      source: "simulated",
      baseUrl: null,
      model: agent.model || config.defaultModel,
      provider: agent.provider,
    };
  }

  throw new ProviderError({
    provider: agent.provider,
    status: 401,
    message: `${config.label} requires an API key. Add one in the session setup or set ${config.apiKeyEnvVar} on the server.`,
    retryable: false,
  });
}

/** True when the browser is allowed to drive this session. */
export function ownsSession(sessionId: string | null, cookieValue: string | null): boolean {
  if (!sessionId || !cookieValue) return false;
  return sessionId === cookieValue;
}
