#!/usr/bin/env node
/**
 * End-to-end verification of the rate-limit contract.
 *
 * Runs a real agent against `scripts/mock-provider.mjs` (which returns a real
 * HTTP 429 with a real `retry-after` header) and asserts the behaviours the
 * spec demands:
 *
 *   1. the agent is parked in PAUSED_RATE_LIMIT;
 *   2. the backoff respects the provider's retry-after;
 *   3. a rate_limit event is written to the room feed;
 *   4. a resume job is scheduled and the agent does come back;
 *   5. other agents are never disturbed.
 *
 * Requires the app to be running (LAB_BASE_URL, default http://127.0.0.1:3000).
 */

const BASE = (process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const MOCK = process.env.MOCK_BASE_URL ?? "http://127.0.0.1:4599/v1";
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 90_000);
const BACKOFF_MIN = Number(process.env.VERIFY_BACKOFF_MIN ?? 2000);
const BACKOFF_MAX = Number(process.env.VERIFY_BACKOFF_MAX ?? 8000);
const LABEL = process.env.VERIFY_LABEL ?? "retry-after";
/** `exhaustion` expects a provider that never lets the agent through. */
const MODE = process.env.VERIFY_MODE ?? "recovery";

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jsonFetch(path, init = {}, cookie = null) {
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, setCookie: response.headers.get("set-cookie") };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\n▸ verifying against ${BASE} (mock provider ${MOCK}, mode: ${LABEL})\n`);

  /* 1 ─ session on the mock provider ------------------------------------- */
  const session = await jsonFetch("/api/session", {
    method: "POST",
    body: JSON.stringify({
      agentName: "Mock Probe",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-mock-verification-key-0001",
      baseUrl: MOCK,
    }),
  });
  if (session.status !== 200) throw new Error(`session creation failed: ${session.status} ${JSON.stringify(session.data)}`);
  const cookie = (session.setCookie ?? "").split(";")[0];
  check("session created", Boolean(cookie), `cookie ${cookie.slice(0, 18)}…`);
  check(
    "api key never returned to the client",
    !JSON.stringify(session.data).includes("sk-mock-verification-key-0001"),
    JSON.stringify(session.data.session.keyHint),
  );

  /* 2 ─ warm the room routes on a throwaway room ------------------------- */
  // Next compiles route handlers on first request, which can take seconds. The
  // parked window we need to observe is ~2.5s, so every route the run depends
  // on is forced to compile before the real room is created.
  const warmupRoom = await jsonFetch(
    "/api/rooms",
    { method: "POST", body: JSON.stringify({ topic: `Warmup ${Date.now()}`, objective: "route compilation warmup" }) },
    cookie,
  );
  if (warmupRoom.status === 201) {
    await jsonFetch(`/api/rooms/${warmupRoom.data.room.id}`, {}, cookie);
    const warmStream = await fetch(`${BASE}/api/rooms/${warmupRoom.data.room.id}/stream`, {
      headers: { cookie, accept: "text/event-stream" },
    });
    await warmStream.body?.cancel();
  }

  /* 3 ─ room with a single throttling agent + one control agent ---------- */
  const created = await jsonFetch(
    "/api/rooms",
    {
      method: "POST",
      body: JSON.stringify({
        topic: `Rate-limit contract probe ${Date.now()}`,
        objective: "Confirm that a throttled agent parks, backs off and resumes without stalling the room.",
        maxAgents: 3,
        iterationBudget: 3,
        cycleIntervalMs: 2500,
      }),
    },
    cookie,
  );
  if (created.status !== 201) throw new Error(`room creation failed: ${created.status} ${JSON.stringify(created.data)}`);
  const roomId = created.data.room.id;
  const probeAgentId = created.data.agent.id;
  check("room created with the caller as agent", Boolean(roomId && probeAgentId), roomId);

  // A second, keyless simulator agent: it must keep iterating throughout.
  const joined = await jsonFetch(
    `/api/rooms/${roomId}/agents`,
    { method: "POST", body: JSON.stringify({ name: "Bystander", provider: "simulated", model: "lab-sim-1" }) },
    cookie,
  );
  check("second agent joined", joined.status === 201, joined.data?.agent?.name ?? JSON.stringify(joined.data));

  /* 4 ─ attach to the live stream *before* the cycles produce output ----- */
  const sseController = new AbortController();
  const liveEvents = [];
  const sse = await fetch(`${BASE}/api/rooms/${roomId}/stream`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: sseController.signal,
  });
  check("SSE stream opens with 200", sse.status === 200, sse.headers.get("content-type") ?? "");

  const ssePump = (async () => {
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          try {
            liveEvents.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch {
      /* aborted at the end of the run */
    }
  })();

  /* 5 ─ observe the room until the budget is spent ----------------------- */
  const started = Date.now();
  const observations = {
    sawPaused: false,
    pausedBackoffMs: null,
    sawRateLimitEntry: false,
    rateLimitMessage: null,
    rateLimitMeta: null,
    sawResume: false,
    probeContributions: 0,
    bystanderContributions: 0,
    probeStatusHistory: [],
    probeError: null,
    sawExperiment: false,
    sawDiscovery: false,
    parkedEpisodes: 0,
    ceilingReached: false,
    finalProbe: null,
  };

  while (Date.now() - started < TIMEOUT_MS) {
    const snapshot = await jsonFetch(`/api/rooms/${roomId}`, {}, cookie);
    if (snapshot.status !== 200) throw new Error(`snapshot failed: ${snapshot.status}`);

    const probe = snapshot.data.agents.find((agent) => agent.id === probeAgentId);
    const bystander = snapshot.data.agents.find((agent) => agent.name === "Bystander");

    if (probe) {
      const last = observations.probeStatusHistory.at(-1);
      if (last !== probe.status) observations.probeStatusHistory.push(probe.status);
      observations.probeContributions = probe.contributions;
      observations.probeError = probe.lastError;

      if (probe.status === "PAUSED_RATE_LIMIT") {
        observations.sawPaused = true;
        observations.pausedBackoffMs = probe.backoffMs;
        if (last !== "PAUSED_RATE_LIMIT") observations.parkedEpisodes += 1;
      }
      observations.finalProbe = probe;
      if (probe.status === "RESEARCHING" || probe.status === "IDLE") {
        if (observations.sawPaused) observations.sawResume = true;
      }
    }
    if (bystander) observations.bystanderContributions = bystander.contributions;

    for (const entry of snapshot.data.entries) {
      if (entry.kind === "rate_limit" && entry.agentId === probeAgentId) {
        observations.sawRateLimitEntry = true;
        observations.rateLimitMessage = entry.title;
        // Durable, timing-independent evidence of what the engine computed.
        observations.rateLimitMeta = observations.rateLimitMeta ?? entry.metadata;
      }
      if (entry.kind === "experiment_run" && entry.agentId === probeAgentId) observations.sawExperiment = true;
      if (entry.kind === "key_discovery" && entry.agentId === probeAgentId) observations.sawDiscovery = true;
      if (entry.kind === "system" && entry.metadata?.kind === "backoff_exhausted") {
        observations.ceilingReached = true;
      }
    }

    if (observations.ceilingReached) break;
    if (probe?.status === "COMPLETED" && observations.sawPaused && observations.sawResume) break;

    await sleep(700);
  }

  // Let the room settle briefly so "the other agents kept working" is measured
  // over a fair window rather than cut short the instant the probe finishes.
  if (MODE !== "exhaustion") {
    await sleep(5000);
    const settled = await jsonFetch(`/api/rooms/${roomId}`, {}, cookie);
    const bystander = settled.data.agents.find((agent) => agent.name === "Bystander");
    if (bystander) observations.bystanderContributions = bystander.contributions;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  sseController.abort();
  await ssePump;

  /* 6 ─ assertions -------------------------------------------------------- */
  check("throttled agent entered PAUSED_RATE_LIMIT", observations.sawPaused);
  check(
    "rate_limit entry persisted the throttle diagnostic",
    observations.rateLimitMeta !== null,
    observations.rateLimitMeta
      ? `source=${observations.rateLimitMeta.source} retryAfter=${observations.rateLimitMeta.retryAfterMs}ms attempt=${observations.rateLimitMeta.attempt}`
      : "missing",
  );
  check("rate_limit event logged to the room feed", observations.sawRateLimitEntry, observations.rateLimitMessage);
  check("other agent kept working throughout", observations.bystanderContributions > 0, `${observations.bystanderContributions} contributions`);

  if (MODE === "exhaustion") {
    // A provider that never relents: the engine must give up deliberately and
    // stop scheduling resumes instead of looping forever.
    check(
      "agent was retried several times before giving up",
      observations.parkedEpisodes >= 2,
      `${observations.parkedEpisodes} park episodes`, 
    );
    check("backoff ceiling marker written to the feed", observations.ceilingReached);
    check(
      "agent ended parked with no scheduled resume",
      observations.finalProbe?.status === "PAUSED_RATE_LIMIT" && observations.finalProbe?.resumeAt === null,
      `status=${observations.finalProbe?.status} resumeAt=${observations.finalProbe?.resumeAt}`,
    );
    check(
      "agent never published a cycle against the hostile provider",
      observations.probeContributions === 0,
      `${observations.probeContributions} contributions`,
    );
  } else {
    check(
      `backoff policy respected (${LABEL}, expected ${BACKOFF_MIN}–${BACKOFF_MAX}ms)`,
      observations.pausedBackoffMs !== null &&
        observations.pausedBackoffMs >= BACKOFF_MIN &&
        observations.pausedBackoffMs <= BACKOFF_MAX,
      `${observations.pausedBackoffMs} ms`,
    );
    check("agent resumed automatically after the backoff", observations.sawResume);
    check(
      "agent completed cycles after resuming",
      observations.probeContributions > 0,
      `${observations.probeContributions} contributions, status history: ${observations.probeStatusHistory.slice(0, 8).join(" → ")}`,
    );
    check("structured experiment entries persisted", observations.sawExperiment);
    check("structured discovery entries persisted", observations.sawDiscovery);
  }

  console.log(`\n  ran for ${elapsed}s`);
  if (observations.probeError) console.log(`  last agent error: ${observations.probeError}`);

  /* 7 ─ live stream assertions (frames pushed while we were watching) ----- */
  check("SSE delivered a hello frame", liveEvents.some((event) => event.type === "hello"), `${liveEvents.length} frames`);
  check(
    "SSE pushed live log_entry frames (not just replay)",
    liveEvents.some((event) => event.type === "log_entry"),
  );
  check(
    "SSE pushed a live rate_limit event",
    liveEvents.some((event) => event.type === "rate_limit"),
  );
  check(
    "SSE pushed agent status transitions",
    liveEvents.some((event) => event.type === "agent_updated"),
  );

  /* 8 ─ runtime health ---------------------------------------------------- */
  const health = await jsonFetch("/api/health", {}, cookie);
  check("scheduler is ticking", (health.data?.runtime?.ticks ?? 0) > 0, `${health.data?.runtime?.ticks} ticks, ${health.data?.runtime?.queuedJobs} queued`);

  const failed = checks.filter((item) => !item.passed);
  console.log(`\n${failed.length === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nverification crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
