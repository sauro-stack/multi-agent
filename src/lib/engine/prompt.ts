import "server-only";

import type {
  Agent,
  AgentCycleOutput,
  LogEntry,
  LogEntryKind,
  ProviderMessage,
  ResearchRoom,
} from "@/lib/types";

import { providerConfig } from "@/lib/providers/config";

/**
 * Prompt construction + tolerant parsing of the structured cycle payload.
 *
 * Providers differ in how strictly they can be pinned to JSON, so the prompt
 * is written to work with or without a provider-side JSON mode, and parsing
 * degrades gracefully instead of failing the cycle.
 */

const CONTEXT_ENTRIES = 10;
const CONTEXT_CHARS = 700;

export interface CycleContext {
  room: ResearchRoom;
  agent: Agent;
  /** Most recent entries across the whole room, oldest first. */
  recent: LogEntry[];
  /** Entry this cycle is explicitly building on, if any. */
  parent: LogEntry | null;
  cycleIntervalMs: number;
}

export function buildCycleMessages(ctx: CycleContext): ProviderMessage[] {
  const config = providerConfig(ctx.agent.provider);
  const system = [
    "You are an autonomous research agent inside a shared, multi-agent research lab.",
    "You iterate without human supervision. Every cycle you read the room's collective state",
    "and publish a structured research update.",
    "",
    "Hard rules:",
    "1. Reply with ONE JSON object and nothing else. No prose before or after, no markdown fences.",
    "2. Never restate another agent's findings as your own — extend, replicate or refute them.",
    "3. Negative results are as valuable as positive ones. Say so explicitly when you find one.",
    "4. Confidence must be calibrated: reserve >0.8 for findings you actually replicated.",
    "",
    "JSON schema (all keys required except experiment_run and key_discovery):",
    "{",
    '  "thought_process": string,            // markdown reasoning for this cycle',
    '  "experiment_run": {                   // omit if this cycle is purely analytical',
    '    "title": string, "method": string, "code": string, "language": string,',
    '    "result": string, "outcome": "confirmed" | "refuted" | "inconclusive"',
    "  },",
    '  "key_discovery": {                    // omit unless you can defend a new claim',
    '    "title": string, "summary": string, "confidence": number, "evidence": string',
    "  },",
    '  "next_steps": string[]',
    "}",
    "",
    `You are: ${ctx.agent.name} (${config.label} / ${ctx.agent.model}).`,
    "Other agents in this room are working in parallel on the same topic.",
  ].join("\n");

  const roomState = [
    `ROOM_TOPIC: ${ctx.room.topic}`,
    `ROOM_OBJECTIVE: ${ctx.room.objective || "produce verifiable, reproducible findings"}`,
    `ROOM_STATUS: ${ctx.room.status}`,
    `AGENT_NAME: ${ctx.agent.name}`,
    `AGENT_PROVIDER: ${config.label}`,
    `AGENT_ITERATION: ${ctx.agent.iteration + 1}`,
    `AGENT_CONTRIBUTIONS: ${ctx.agent.contributions}`,
    `ITERATION_BUDGET: ${ctx.room.iterationBudget}`,
    `CYCLE_INTERVAL_MS: ${ctx.cycleIntervalMs}`,
  ].join("\n");

  const logBlock = ctx.recent.length
    ? [
        "COLLECTIVE_LOG (oldest first, truncated):",
        ...ctx.recent.map(
          (entry) =>
            `- [${entry.kind}] ${entry.title} — by ${entry.agentName} (iter ${entry.iteration})\n  ${entry.content
              .replace(/\s+/g, " ")
              .slice(0, CONTEXT_CHARS)}`,
        ),
      ].join("\n")
    : "COLLECTIVE_LOG: empty. You are the first agent to publish; establish the baseline.";

  const focus = ctx.parent
    ? `BUILD_ON: entry "${ctx.parent.title}" by ${ctx.parent.agentName} (kind: ${ctx.parent.kind}). Extend, replicate or refute it — do not ignore it.`
    : "BUILD_ON: nothing specific. Open a fresh line of inquiry that is clearly labelled as speculative.";

  const user = [
    roomState,
    "",
    logBlock,
    "",
    focus,
    "",
    `Produce cycle ${ctx.agent.iteration + 1}. Reply with the JSON object only.`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Extracts the JSON object from a model reply, tolerating fences and prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.map((v) => asString(v)).join("\n");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.map((v) => asString(v)).filter(Boolean);
    if (items.length) return items;
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split("\n")
      .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
      .filter(Boolean);
  }
  return fallback;
}

/**
 * Normalises whatever the model returned into `AgentCycleOutput`.
 *
 * A reply that is not JSON at all is still useful — we file it as the thought
 * process rather than burning the cycle.
 */
export function normaliseCycleOutput(raw: string): AgentCycleOutput {
  const parsed = extractJsonObject(raw);

  if (!parsed) {
    return {
      thought_process: raw.trim().slice(0, 6000) || "No output produced this cycle.",
      next_steps: ["Re-issue the request with stricter JSON formatting instructions."],
    };
  }

  const thought =
    asString(
      parsed.thought_process ?? parsed.thoughtProcess ?? parsed.reasoning ?? parsed.thought,
      "",
    ) || "No explicit reasoning was returned.";

  const experimentRaw = (parsed.experiment_run ?? parsed.experimentRun ?? parsed.experiment) as
    | Record<string, unknown>
    | undefined;

  const experiment = experimentRaw
    ? {
        title: asString(experimentRaw.title, `Experiment ${asString(experimentRaw.method).slice(0, 40)}`),
        method: asString(experimentRaw.method, "Method not specified."),
        code: asString(experimentRaw.code).slice(0, 4000) || undefined,
        language: asString(experimentRaw.language, "text") || "text",
        result: asString(experimentRaw.result, "No result recorded."),
        outcome: (["confirmed", "refuted", "inconclusive"].includes(asString(experimentRaw.outcome))
          ? asString(experimentRaw.outcome)
          : "inconclusive") as "confirmed" | "refuted" | "inconclusive",
      }
    : undefined;

  const discoveryRaw = (parsed.key_discovery ?? parsed.keyDiscovery ?? parsed.discovery) as
    | Record<string, unknown>
    | undefined;

  const discovery = discoveryRaw
    ? (() => {
        const confidenceRaw = Number(discoveryRaw.confidence);
        const confidence = Number.isFinite(confidenceRaw)
          ? Math.min(1, Math.max(0, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw))
          : 0.5;
        return {
          title: asString(discoveryRaw.title, "Untitled discovery"),
          summary: asString(discoveryRaw.summary ?? discoveryRaw.detail, "No summary provided."),
          confidence,
          evidence: asString(discoveryRaw.evidence) || undefined,
        };
      })()
    : undefined;

  return {
    thought_process: thought,
    experiment_run: experiment,
    key_discovery: discovery,
    next_steps: asStringArray(parsed.next_steps ?? parsed.nextSteps, [
      "Gather more evidence before promoting this line of inquiry.",
    ]),
  };
}

export interface PendingEntry {
  kind: LogEntryKind;
  title: string;
  content: string;
  code?: string | null;
  codeLanguage?: string | null;
  confidence?: number | null;
  /** Temporary key used to wire parent links before IDs exist. */
  slot: string;
  parentSlot?: string | null;
  /** Experiment outcome, used to label graph edges. */
  outcome?: "confirmed" | "refuted" | "inconclusive";
}

/**
 * Converts a normalised cycle into the ordered set of entries to persist.
 * Parent links form the per-cycle chain that the discovery graph renders.
 */
export function cycleToEntries(output: AgentCycleOutput, ctx: CycleContext): PendingEntry[] {
  const entries: PendingEntry[] = [];
  const parentRef = ctx.parent ? ctx.parent.id : null;

  entries.push({
    kind: "thought_process",
    title: firstLine(output.thought_process, `Cycle ${ctx.agent.iteration + 1} reasoning`),
    content: output.thought_process,
    slot: "thought",
    parentSlot: null,
    confidence: null,
  });

  let lastSlot = "thought";

  if (output.experiment_run) {
    const exp = output.experiment_run;
    const outcomeTag =
      exp.outcome === "confirmed" ? "confirmed" : exp.outcome === "refuted" ? "refuted" : "inconclusive";
    entries.push({
      kind: "experiment_run",
      title: exp.title || `Experiment ${ctx.agent.iteration + 1}`,
      content: [`**Method.** ${exp.method}`, "", `**Result (${outcomeTag}).** ${exp.result}`].join("\n"),
      code: exp.code ?? null,
      codeLanguage: exp.language ?? null,
      slot: "experiment",
      parentSlot: "thought",
      confidence: null,
      outcome: outcomeTag,
    });
    lastSlot = "experiment";
  }

  if (output.key_discovery) {
    const discovery = output.key_discovery;
    entries.push({
      kind: "key_discovery",
      title: discovery.title,
      content: [
        discovery.summary,
        "",
        discovery.evidence ? `**Evidence.** ${discovery.evidence}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      slot: "discovery",
      parentSlot: lastSlot,
      confidence: discovery.confidence,
    });
    lastSlot = "discovery";
  }

  entries.push({
    kind: "next_steps",
    title: "Next steps",
    content: output.next_steps.map((step) => `- ${step}`).join("\n"),
    slot: "next",
    parentSlot: lastSlot,
  });

  // The first entry always hangs off whatever the cycle declared it built on.
  entries[0].parentSlot = parentRef ? `ext:${parentRef}` : null;

  return entries;
}

function firstLine(markdown: string, fallback: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^[#*\s]+/, "").trim())
    .find((l) => l.length > 8);
  if (!line) return fallback;
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
}
