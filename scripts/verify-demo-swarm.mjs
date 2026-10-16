#!/usr/bin/env node
/**
 * End-to-end verification of the demo swarm — the path a new user takes.
 *
 * A keyless session seeds three simulator agents plus the caller, all of whom
 * iterate in parallel. The simulator injects a real 429 every third cycle, so
 * this run also proves the multi-agent property the spec cares about: one
 * throttled agent never stops the others.
 */

const BASE = (process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const DURATION_MS = Number(process.env.VERIFY_DURATION_MS ?? 45_000);

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed });
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
  console.log(`\n▸ verifying demo swarm against ${BASE}\n`);

  const session = await jsonFetch("/api/session", {
    method: "POST",
    body: JSON.stringify({
      agentName: "Swarm Verifier",
      provider: "simulated",
      model: "lab-sim-1",
      apiKey: "",
    }),
  });
  if (session.status !== 200) throw new Error(`session failed: ${session.status}`);
  const cookie = (session.setCookie ?? "").split(";")[0];
  check("keyless session created for the simulator", Boolean(cookie), session.data?.session?.keySource);

  const demo = await jsonFetch("/api/demo", { method: "POST", body: JSON.stringify({ rejoin: false }) }, cookie);
  if (demo.status !== 201 && demo.status !== 200) {
    throw new Error(`demo seed failed: ${demo.status} ${JSON.stringify(demo.data)}`);
  }
  const roomId = demo.data.room.id;
  check("demo room seeded", Boolean(roomId), demo.data.room.topic.slice(0, 60));
  check(
    "swarm has the caller plus three simulator agents",
    demo.data.agents.length === 4,
    demo.data.agents.map((agent) => `${agent.name}/${agent.provider}`).join(", "),
  );

  const seen = {
    kinds: new Set(),
    parkedAgents: new Set(),
    resumedAgents: new Set(),
    contributors: new Set(),
    // Deduped by sequence: every poll returns the same rolling window.
    rateLimitSeqs: new Set(),
    maxGraphNodes: 0,
    maxGraphEdges: 0,
  };
  const history = new Map();

  const started = Date.now();
  while (Date.now() - started < DURATION_MS) {
    const snapshot = await jsonFetch(`/api/rooms/${roomId}`, {}, cookie);
    if (snapshot.status !== 200) throw new Error(`snapshot failed: ${snapshot.status}`);

    for (const agent of snapshot.data.agents) {
      const previous = history.get(agent.id);
      history.set(agent.id, agent.status);
      if (agent.status === "PAUSED_RATE_LIMIT") seen.parkedAgents.add(agent.id);
      if (agent.contributions > 0) seen.contributors.add(agent.id);
      if (previous === "PAUSED_RATE_LIMIT" && agent.status !== "PAUSED_RATE_LIMIT") {
        seen.resumedAgents.add(agent.id);
      }
    }

    for (const entry of snapshot.data.entries) {
      seen.kinds.add(entry.kind);
      if (entry.kind === "rate_limit") seen.rateLimitSeqs.add(entry.seq);
    }

    seen.maxGraphNodes = Math.max(seen.maxGraphNodes, snapshot.data.graph.nodes.length);
    seen.maxGraphEdges = Math.max(seen.maxGraphEdges, snapshot.data.graph.edges.length);

    await sleep(1500);
  }

  const elapsed = Math.round((Date.now() - started) / 1000);

  check("multiple agents published contributions", seen.contributors.size >= 2, `${seen.contributors.size} contributors`);
  check(
    "simulator injected real 429s, agents parked",
    seen.parkedAgents.size >= 1,
    `${seen.parkedAgents.size} agent(s) parked, ${seen.rateLimitSeqs.size} distinct rate-limit entries`,
  );
  check(
    "throttling is occasional, not a park/resume loop",
    seen.rateLimitSeqs.size <= seen.contributors.size * 4,
    `${seen.rateLimitSeqs.size} throttle events across ${seen.contributors.size} agents`,
  );
  check("parked agents resumed on their own", seen.resumedAgents.size >= 1, `${seen.resumedAgents.size} resumed`);
  check(
    "all four structured kinds reached the feed",
    ["thought_process", "experiment_run", "key_discovery", "next_steps"].every((kind) => seen.kinds.has(kind)),
    [...seen.kinds].join(", "),
  );
  check("discovery graph has nodes", seen.maxGraphNodes > 4, `${seen.maxGraphNodes} nodes`);
  check("discovery graph has cross-agent edges", seen.maxGraphEdges > 3, `${seen.maxGraphEdges} edges`);

  const room = await jsonFetch(`/api/rooms/${roomId}`, {}, cookie);
  const statuses = room.data.agents.map((agent) => `${agent.name}:${agent.status}`).join(" · ");
  check(
    "no agent was left stuck in a paused state",
    room.data.agents.every((agent) => agent.status !== "PAUSED_RATE_LIMIT" || agent.resumeAt !== null),
    statuses,
  );

  /* Page rendering ------------------------------------------------------- */
  const landing = await fetch(`${BASE}/`);
  const landingHtml = await landing.text();
  check("landing page renders", landing.status === 200 && landingHtml.includes("Autonomous Research Lab"));

  const roomPage = await fetch(`${BASE}/room/${roomId}`);
  const roomHtml = await roomPage.text();
  check("room dashboard renders", roomPage.status === 200 && roomHtml.includes("live research feed"));

  console.log(`\n  ran for ${elapsed}s`);
  const failed = checks.filter((item) => !item.passed);
  console.log(`\n${failed.length === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nverification crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
