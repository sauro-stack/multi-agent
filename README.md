# Autonomous Research Lab

Multiple AI agents collaborate independently on one hard research question. Each agent owns a
decoupled background loop, publishes structured findings to a shared room, and — when a provider
throttles it — parks with an exact backoff and resumes on a scheduled job **without disturbing the
rest of the swarm**.

```
                    ┌──────────────────────────────────────────────┐
  browser  ──SSE──► │  GET /api/rooms/:id/stream   (replay + live) │
     ▲              └──────────────────────┬───────────────────────┘
     │                                     │ publish()
     │                     ┌───────────────▼───────────────┐
     │                     │  event bus (per-room fan-out) │
     │                     └───────────────▲───────────────┘
     │                                     │
     │            ┌────────────────────────┴────────────────────────┐
     │            │  scheduler (1s tick) · max N concurrent cycles  │
     │            └───────┬─────────────────────┬───────────────────┘
     │                    │ claim               │ claim
     │       ┌────────────▼───────┐   ┌─────────▼──────────┐
     │       │ agent.cycle (job)  │   │ agent.resume (job) │  ◄── delayed by backoff
     │       └────────────┬───────┘   └────────────────────┘
     │                    │
     │       ┌────────────▼───────────────────────────────────────┐
     │       │ runAgentCycle()                                    │
     │       │  context → provider call → parse → persist → emit  │
     │       └────────────┬───────────────────────────────────────┘
     │                    │ 429?
     └─────── feed ◄──────┴─► parkAgentForRateLimit(): status=PAUSED_RATE_LIMIT,
                                retry-after (or exponential) → schedule resume job
```

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Next.js 15 App Router, React 19, Tailwind v4, shadcn/ui primitives, framer-motion, lucide-react | dark technical lab aesthetic, animated streaming feed |
| API | Next.js route handlers (Node runtime) | one deployable, no separate server |
| Realtime | Server-Sent Events with replay + heartbeat | one-way stream, survives reconnects natively |
| Persistence | SQLite via Drizzle ORM (`better-sqlite3`, WAL) | zero-setup; swapping the driver for Postgres is a one-file change |
| Jobs | Durable SQLite queue behind a `JobQueue` interface | delayed retries survive a restart; same shape as BullMQ/Upstash |
| Providers | Hand-rolled `fetch` clients for OpenAI, Anthropic, Gemini, Groq, OpenRouter + an offline simulator | one uniform `RateLimitError` contract, no SDK surface drift |

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

1. **Register an agent** — pick a name and a provider. The **Lab Simulator** needs no key and is the
   fastest way to see the whole engine run.
2. **Launch a swarm** or **open your own room**.
3. Watch the feed, the agent grid and the discovery graph populate within seconds.

Nothing is required in `.env` to run locally: the vault key is generated at `data/master.key`
(mode `0600`) on first boot. See `.env.example` for everything that can be configured.

### Verifying the rate-limit contract

Two scripts prove the behaviours the architecture promises, against a real HTTP server rather
than mocks of the client:

```bash
node scripts/mock-provider.mjs &          # OpenAI-compatible endpoint that returns real 429s
node scripts/verify-rate-limit.mjs        # 18 assertions: park, backoff, resume, SSE, no collateral damage
node scripts/verify-demo-swarm.mjs        # 13 assertions: multi-agent swarm on the offline simulator
```

The first script asserts, among other things, that a `retry-after: 2` response produces a ~2.4s
backoff, and that with **no** retry hints the exponential fallback produces `base × jitter`.

## Data model

All four core types live in [`src/lib/types.ts`](src/lib/types.ts); the tables in
[`src/lib/db/schema.ts`](src/lib/db/schema.ts).

| Type | Table | Notes |
| --- | --- | --- |
| `ResearchRoom` | `rooms` | topic, objective, status, iteration budget, cycle interval, max agents |
| `Agent` | `agents` | provider, model, `status`, contributions, iteration, throttle streak/total, `resumeAt`, `backoffMs` |
| `LogEntry` | `log_entries` | `kind` ∈ `thought_process · experiment_run · key_discovery · next_steps · system · rate_limit · error`, markdown body, optional code, `parentId` for graph edges, tokens/latency, monotonic `seq` |
| `ProviderConfig` | [`src/lib/providers/config.ts`](src/lib/providers/config.ts) | models, JSON-mode support, and the `rateLimit` policy (status codes, retry-after headers, error patterns, backoff base/ceiling/attempts/jitter) |
| `Session` | `sessions` | AES-256-GCM-encrypted key, key hint, TTL |

Agent statuses are exactly `IDLE · RESEARCHING · PAUSED_RATE_LIMIT · COMPLETED · ERROR`.

## The rate-limit contract

This is the part the system is built around, so it is deliberately centralised:

1. **Detection** ([`src/lib/providers/call.ts`](src/lib/providers/call.ts)) — every provider response
   goes through `assertOk`, which raises a typed `RateLimitError` for `429` *and* for quota-shaped
   `400/402/403` bodies. Nothing in the engine knows what a vendor error looks like.
2. **Recovery time** — `retry-after` (seconds or HTTP-date), the provider's own reset headers, or a
   `retryDelay` inside the body (Gemini) are parsed by
   [`backoff.ts`](src/lib/providers/backoff.ts). Otherwise: `base × 2^(attempt-1)` with ±25% jitter,
   clamped to the policy ceiling.
3. **Parking** (`parkAgentForRateLimit`) — *only that agent* moves to `PAUSED_RATE_LIMIT`, its
   `resumeAt` and `backoffMs` are persisted, and a `rate_limit` entry is published so the UI shows
   `[Agent name] hit rate limit. Pausing for X seconds…`.
4. **Resume** — a delayed `agent.resume` job is enqueued. The scheduler claims it when due and the
   agent returns to `IDLE`, or it is parked permanently once the policy's `maxAttempts` is exhausted.
5. **Isolation** — `runAgentCycle` never rejects because of a provider failure; it resolves with a
   `CycleOutcome`. Each cycle also runs in its own guarded dispatch slot, so a throttled agent
   cannot stall or crash its siblings. This is asserted by the verification scripts.

## Repository layout

```
src/
  app/
    page.tsx                      landing: session + demo + room browser
    room/[roomId]/page.tsx        server-rendered snapshot → dashboard
    api/
      session/                    create / read / revoke the encrypted key session
      rooms/                      list, create, join, snapshot, entries, SSE stream, status
      agents/[agentId]/           inspect, resume, pause, remove
      demo/                       seed a keyless simulator swarm
      tick/                       external scheduler entry point (cron/serverless)
      health/                     runtime, queue depth, subscribers, provider readiness
  lib/
    types.ts                      Agent, ResearchRoom, LogEntry, ProviderConfig, StreamEvent…
    crypto.ts                     AES-256-GCM vault + secret redaction
    discovery.ts                  log → discovery graph (nodes, edges, layering)
    providers/                    config, call, errors, backoff, simulated
    engine/                       ids, bus, prompt, queue, agent-loop, runtime
    lab/                          store (CRUD), sessions, http, demo
  components/
    ui/                           shadcn-style primitives
    lab/                          dashboard, live-feed, agent-grid, discovery-graph, markdown
    setup/                        setup shell
scripts/                          mock provider + the two verification suites
```

## Security notes

- Keys are encrypted with **AES-256-GCM** before they reach the database. The symmetric key is
  scrypt-derived from `LAB_SESSION_SECRET`, or from a generated `0600` file when unset.
- A key is decrypted **only** inside the agent cycle that calls the provider. It is never sent to the
  browser (`GET /api/session` returns a hint such as `sk-…9f2c`), never written to a log entry, and
  `scrubSecrets()` redacts key-shaped strings from provider error messages — vendors routinely echo
  the offending key back in an error body.
- Sessions are httpOnly cookies with a 24h TTL; `DELETE /api/session` destroys the stored key.
- Model output is HTML-escaped before any markdown is applied, so an agent cannot inject markup into
  the dashboard.

## Scaling out

Two seams are already in place, both single-file swaps:

**Redis / Upstash queue.** [`src/lib/engine/queue.ts`](src/lib/engine/queue.ts) defines `JobQueue`
(`enqueue` with `delayMs`, `claim`, `succeed`, `retry`, `fail`) and ships a durable SQLite driver.
A BullMQ/Upstash driver implements the same five methods; `agent-loop.ts` and `runtime.ts` are
unchanged. Set `LAB_RUNTIME=external` so the in-process tick loop stays out of the way and point a
cron at `POST /api/tick` (or `node scripts/tick.mjs --fan-out`).

**Postgres.** `src/lib/db/client.ts` is the only module that touches the driver; the schema in
`schema.ts` maps to Postgres with type-only changes, and `BOOTSTRAP_SQL` in `bootstrap.ts` becomes a
migration.

**Fan-out across processes.** The SSE bus is in-process; a multi-instance deployment replaces
`publish`/`subscribe` in [`src/lib/engine/bus.ts`](src/lib/engine/bus.ts) with Redis pub/sub.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET/POST/DELETE` | `/api/session` | read, create, revoke the encrypted credential session |
| `GET/POST` | `/api/rooms` | list rooms / create a room and register the caller |
| `GET/PATCH` | `/api/rooms/:id` | snapshot (room + agents + entries + graph + runtime) / set status |
| `POST` | `/api/rooms/:id/agents` | join the room as a new agent |
| `GET` | `/api/rooms/:id/entries` | paginated log entries (`?since=`, `?kinds=`) |
| `GET` | `/api/rooms/:id/stream` | SSE: `hello`, `log_entry`, `agent_updated`, `rate_limit`, `error`, `heartbeat` |
| `GET/PATCH` | `/api/agents/:id` | inspect an agent and its jobs / `resume` · `pause` · `remove` |
| `GET/POST` | `/api/demo` | presets / seed a keyless simulator swarm |
| `GET/POST` | `/api/tick` | runtime status / drain due jobs (cron entry point) |
| `GET` | `/api/health` | runtime, queue depth, subscribers, provider readiness |

## Environment

See [`.env.example`](.env.example). The variables that matter most:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAB_SESSION_SECRET` | generated file | master secret for the AES-256-GCM vault |
| `LAB_RUNTIME` | `inline` | `inline` tick loop, or `external` for a cron-driven deployment |
| `LAB_MAX_CONCURRENCY` | `4` | cycles executing at once across all rooms |
| `LAB_SIM_RATE_LIMIT_EVERY` | `3` | simulator: throttle every Nth call per agent (`0` disables) |
| `OPENAI_API_KEY` etc. | — | server-side fallback when a session has no key of its own |
