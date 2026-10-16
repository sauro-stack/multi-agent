import "server-only";

import type { AgentCycleOutput, ProviderCallOptions, ProviderCallResult, ProviderConfig } from "@/lib/types";

import { RateLimitError } from "./errors";

/**
 * Offline "model".
 *
 * Produces a plausible, topic-aware research cycle so the whole system can be
 * exercised (and demoed) without provider credentials. Crucially it emits the
 * same `RateLimitError` shape a real provider would, on a deterministic
 * schedule, which is what lets us verify the pause/resume path end to end.
 */

interface SimCallState {
  calls: number;
  lastThrottleAt: number;
}

/** Per-agent call counters, shared across hot reloads. */
function simState(): Map<string, SimCallState> {
  const holder = globalThis as unknown as { __arlSimState?: Map<string, SimCallState> };
  if (!holder.__arlSimState) holder.__arlSimState = new Map();
  return holder.__arlSimState;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

/** Pulls the room topic / agent name / iteration back out of the prompt. */
interface PromptContext {
  topic: string;
  objective: string;
  agentName: string;
  iteration: number;
  recentTitles: string[];
}

function readContext(messages: ProviderCallOptions["messages"]): PromptContext {
  const all = messages.map((m) => m.content).join("\n");
  const grab = (label: string, fallback: string) => {
    const match = all.match(new RegExp(`${label}:\\s*(.+)`));
    return match ? match[1].trim() : fallback;
  };
  const topic = grab("ROOM_TOPIC", "autonomous multi-agent research");
  const objective = grab("ROOM_OBJECTIVE", "produce verifiable findings");
  const agentName = grab("AGENT_NAME", "Simulated Agent");
  const iteration = Number(grab("AGENT_ITERATION", "1").replace(/[^\d]/g, "")) || 1;
  const recentTitles = Array.from(all.matchAll(/^- \[([a-z_]+)\]\s*(.+)$/gm))
    .slice(-6)
    .map((m) => `${m[1]}: ${m[2]}`);

  return { topic, objective, agentName, iteration, recentTitles };
}

const HYPOTHESIS_FRAMES = [
  (t: string, i: number) =>
    `Scaling ${t} along the *representation* axis rather than the data axis will dominate at cycle ${i}`,
  (t: string) => `The bottleneck in ${t} is a routing/allocation problem, not a capacity problem`,
  (t: string) => `${t} exhibits a sharp phase transition reproducible with a small synthetic probe`,
  (t: string) => `Ablating the highest-attribution component in ${t} will degrade performance super-linearly`,
  (t: string) => `Two independent mechanisms in ${t} are being conflated by the current metric`,
];

const METHODS = [
  "counterfactual ablation sweep with matched compute budget",
  "sparse autoencoder probe over the residual stream",
  "randomised controlled A/B over 8 seeds with paired bootstrap CIs",
  "gradient-attribution ranking cross-checked against a permutation null",
  "synthetic probe task with injected ground-truth structure",
];

const CODE_SNIPPETS = [
  (t: string) => `import numpy as np
from scipy.stats import bootstrap

def probe_effect(model, data, seeds=(0, 1, 2, 3, 4, 5, 6, 7), alpha=0.05):
    """Paired bootstrap over seeds for ${t}."""
    deltas = []
    for seed in seeds:
        rng = np.random.default_rng(seed)
        base = evaluate(model, data, ablate=None, rng=rng)
        treated = evaluate(model, data, ablate="top_component", rng=rng)
        deltas.append(np.mean(base) - np.mean(treated))

    deltas = np.asarray(deltas)
    lo, hi = np.percentile(deltas, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return {"mean": float(deltas.mean()), "ci": (float(lo), float(hi)), "n": len(deltas)}

if __name__ == "__main__":
    result = probe_effect(load_model(), load_eval_set())
    print(result)
    assert result["ci"][0] > 0, "effect not distinguishable from null"`,
  (t: string) => `import torch

def train_probe(model, probing_set, epochs=200, lr=1e-3):
    """Linear probe isolating the mechanism behind ${t}."""
    probe = torch.nn.Linear(model.hidden_size, probing_set.n_labels)
    opt = torch.optim.Adam(probe.parameters(), lr=lr)
    loss_fn = torch.nn.CrossEntropyLoss()

    for epoch in range(epochs):
        for batch in probing_set.loader():
            with torch.no_grad():
                features = model.residual_stream(batch.tokens, layer=17)
            loss = loss_fn(probe(features[:, -1]), batch.labels)
            opt.zero_grad(); loss.backward(); opt.step()

    return probe, probe.eval_accuracy(probing_set)`,
  (t: string) => `from collections import Counter

def attribute_components(traces, k=8):
    """Ranks components by causal effect; validates ${t}."""
    scores = Counter()
    for trace in traces:
        for component, effect in trace.causal_effects.items():
            scores[component] += abs(effect) * trace.weight
    ranked = scores.most_common(k)
    return ranked, ranked[0][1] / max(1.0, sum(s for _, s in ranked))`,
];

const DISCOVERY_TEMPLATES = [
  (t: string) => ({
    title: "Cross-agent convergence on a mechanistic explanation",
    summary: `Two independent probes over ${t} agree on the same attribution ordering, which is unlikely under the null (p<0.01). The effect survives a permutation control and a matched-compute ablation.`,
  }),
  (t: string) => ({
    title: "Refutation of the naive capacity hypothesis",
    summary: `Increasing capacity in ${t} yields sub-linear returns while routing entropy rises sharply, so the limiting factor is allocation rather than headroom.`,
  }),
  (t: string) => ({
    title: "Reproducible phase transition located",
    summary: `A sharp transition in ${t} appears between two adjacent configurations and reproduces across 8 seeds; the transition point tracks an interpretable quantity rather than raw scale.`,
  }),
];

const CONTRADICTIONS = [
  "the effect disappears once the shared pre-processing step is removed",
  "the confidence interval straddles zero at the current sample size",
  "a competing agent's replication produced the opposite sign, so the metric is contested",
];

export function buildCycleOutput(
  options: ProviderCallOptions,
  config: ProviderConfig,
): AgentCycleOutput {
  const ctx = readContext(options.messages);
  const rand = mulberry32(hash(`${ctx.agentName}|${ctx.iteration}|${ctx.topic}`));
  const frame = pick(rand, HYPOTHESIS_FRAMES);
  const method = pick(rand, METHODS);
  const snippet = pick(rand, CODE_SNIPPETS);
  const outcome = pick(rand, ["confirmed", "confirmed", "inconclusive", "refuted"] as const);
  const emitDiscovery = outcome === "confirmed" && ctx.iteration % 2 === 0;
  const contradiction = pick(rand, CONTRADICTIONS);

  const priorContext = ctx.recentTitles.length
    ? `I read ${ctx.recentTitles.length} recent entries from the shared log; the most relevant was ${ctx.recentTitles[ctx.recentTitles.length - 1]}.`
    : "The shared log is empty, so I am establishing a baseline first.";

  const thought = [
    `**Cycle ${ctx.iteration} on "${ctx.topic}".**`,
    "",
    `${priorContext}`,
    "",
    `Objective under analysis: ${ctx.objective}.`,
    "",
    `Hypothesis: ${frame(ctx.topic, ctx.iteration)}.`,
    outcome === "refuted"
      ? `My own run came back ${outcome} — ${contradiction}. I am marking this branch as a dead end rather than raising confidence.`
      : `If this holds I expect a measurable, reproducible delta under ${method}.`,
    "",
    `Baseline to beat: whatever the strongest existing entry in the log reports. I will re-run with a wider seed set before claiming anything.`,
  ].join("\n");

  const experiment = {
    title: `Experiment ${ctx.iteration}: ${method}`,
    method: `Ran ${method} against the current room state, holding compute matched to the cheapest competing configuration.`,
    code: snippet(ctx.topic),
    language: "python",
    result:
      outcome === "confirmed"
        ? `Effect detected (delta ${(0.04 + rand() * 0.22).toFixed(3)}, CI excludes zero). ${ctx.iteration % 3 === 0 ? "Replicated on a held-out seed block." : "Replication pending a held-out seed block."}`
        : outcome === "refuted"
          ? `No effect: ${contradiction}. Recorded as a negative result.`
          : `Signal present but underpowered; ${contradiction}. Needs more seeds before it can be promoted.`,
    outcome,
  } as AgentCycleOutput["experiment_run"];

  const discovery = emitDiscovery
    ? (() => {
        const template = pick(rand, DISCOVERY_TEMPLATES)(ctx.topic);
        return {
          title: template.title,
          summary: `${template.summary} Discovered by ${ctx.agentName} in cycle ${ctx.iteration}.`,
          confidence: Number((0.62 + rand() * 0.33).toFixed(2)),
          evidence: `experiment ${ctx.iteration} (${method})`,
        };
      })()
    : undefined;

  const nextSteps = [
    `Re-run the probe with 16 seeds to tighten the interval around the ${outcome} result.`,
    emitDiscovery
      ? "Ask another agent to independently replicate this finding before treating it as settled."
      : "Cross-check against the strongest contradictory entry in the room log.",
    `Quantify how sensitive ${ctx.topic} is to the evaluation-set choice.`,
  ];

  return {
    thought_process: thought,
    experiment_run: experiment,
    key_discovery: discovery,
    next_steps: nextSteps,
  };
}

/**
 * Decides whether this call should be throttled.
 *
 * Keyed off a **per-agent call counter**, not the cycle number: a real provider
 * throttles on request rate, and the cycle number does not advance while an
 * agent is parked. Keying off the cycle number would re-throttle every resume
 * forever (which is exactly the bug this replaced).
 */
function shouldThrottle(config: ProviderConfig, ctx: PromptContext): boolean {
  const key = `${ctx.agentName}`;
  const state = simState().get(key) ?? { calls: 0, lastThrottleAt: 0 };
  state.calls += 1;
  simState().set(key, state);

  if (process.env.LAB_SIM_FORCE_RATE_LIMIT === "1") return true;

  const every = Number(process.env.LAB_SIM_RATE_LIMIT_EVERY ?? "3");
  if (!Number.isFinite(every) || every <= 0) return false;

  // Let the first two calls through so every agent establishes a baseline
  // before the room starts showing throttling.
  if (state.calls < 3) return false;

  const cooldownMs = Number(process.env.LAB_SIM_THROTTLE_COOLDOWN_MS ?? "5000");
  const due = state.calls % every === 0;
  const cooled = Date.now() - state.lastThrottleAt > cooldownMs;

  if (due && cooled) {
    state.lastThrottleAt = Date.now();
    return true;
  }
  return false;
}

export async function callSimulated(
  config: ProviderConfig,
  options: ProviderCallOptions,
): Promise<ProviderCallResult> {
  const started = Date.now();
  const ctx = readContext(options.messages);

  // Simulated network latency so the UI timeline looks believable.
  await new Promise((resolve) => setTimeout(resolve, 250 + Math.round(Math.random() * 450)));

  if (shouldThrottle(config, ctx)) {
    const retryAfterMs = 6000 + Math.round(Math.random() * 9000);
    throw new RateLimitError({
      provider: "simulated",
      status: 429,
      source: "header",
      retryAfterMs,
      policy: config.rateLimit,
      message:
        "Rate limit reached for lab-sim-1: 200000 TPM (tokens per minute) exceeded — simulated throttle",
      body: JSON.stringify({
        error: {
          message: "simulated rate limit",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
        },
      }),
    });
  }

  const output = buildCycleOutput(options, config);
  const promptChars = options.messages.reduce((sum, m) => sum + m.content.length, 0);

  return {
    text: JSON.stringify(output, null, 2),
    model: options.model,
    provider: "simulated",
    usage: {
      inputTokens: Math.round(promptChars / 4),
      outputTokens: Math.round(JSON.stringify(output).length / 4),
    },
    latencyMs: Date.now() - started,
    rateLimitHeaders: { "x-ratelimit-remaining-requests": String(Math.max(0, 100 - ctx.iteration)) },
    finishReason: "stop",
  };
}
