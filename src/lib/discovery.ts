import type {
  DiscoveryEdge,
  DiscoveryGraph,
  DiscoveryNode,
  DiscoveryNodeStage,
  LogEntry,
  LogEntryKind,
  Tone,
} from "@/lib/types";

/**
 * Derives the discovery graph from the room log.
 *
 * Two edge sources are combined:
 *  - **structural**: each entry's `parentId`, which chains a cycle together and
 *    links it to the cross-agent entry it explicitly built on;
 *  - **influence**: `metadata.contextEntryIds`, the entries the agent actually
 *    read as context, which is where cross-agent idea flow shows up.
 */

const STAGE_BY_KIND: Record<string, DiscoveryNodeStage | undefined> = {
  thought_process: "hypothesis",
  experiment_run: "experiment",
  key_discovery: "discovery",
  next_steps: "next",
};

export const GRAPH_KIND_SET: LogEntryKind[] = [
  "thought_process",
  "experiment_run",
  "key_discovery",
  "next_steps",
];

function stageOf(entry: LogEntry): DiscoveryNodeStage | null {
  return STAGE_BY_KIND[entry.kind] ?? null;
}

function label(entry: LogEntry): string {
  const raw = entry.title || entry.content.split("\n")[0] || entry.kind;
  return raw.length > 72 ? `${raw.slice(0, 69)}…` : raw;
}

export function buildDiscoveryGraph(entries: LogEntry[], maxNodes = 60): DiscoveryGraph {
  const relevant = entries.filter((entry) => stageOf(entry) !== null).slice(-maxNodes);
  const byId = new Map(relevant.map((entry) => [entry.id, entry]));

  const nodes: DiscoveryNode[] = relevant.map((entry) => ({
    id: entry.id,
    stage: stageOf(entry) as DiscoveryNodeStage,
    label: label(entry),
    agentId: entry.agentId,
    agentName: entry.agentName,
    provider: entry.provider,
    confidence: entry.confidence,
    iteration: entry.iteration,
    createdAt: entry.createdAt,
    entry,
  }));

  const edges = new Map<string, DiscoveryEdge>();
  const push = (edge: DiscoveryEdge) => {
    if (edge.from === edge.to) return;
    if (!byId.has(edge.from) || !byId.has(edge.to)) return;
    edges.set(`${edge.from}->${edge.to}`, edge);
  };

  for (const entry of relevant) {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    if (parent) {
      let kind: DiscoveryEdge["kind"] = "continued";
      if (entry.kind === "key_discovery" && parent.kind === "experiment_run") {
        const outcome = (parent.metadata?.outcome as string | undefined) ?? "inconclusive";
        kind = outcome === "refuted" ? "contradicted" : "verified";
      }
      push({ id: `${parent.id}->${entry.id}`, from: parent.id, to: entry.id, kind });
    }

    // Influence edges: only the two most recent entries this agent read that
    // were authored by *someone else*. Without this cap the graph turns into a
    // hairball, and same-agent context links are already covered by parentId.
    const contextIds = (entry.metadata?.contextEntryIds as string[] | undefined) ?? [];
    const crossAgent = contextIds
      .map((contextId) => byId.get(contextId))
      .filter((candidate): candidate is LogEntry => Boolean(candidate))
      .filter((candidate) => candidate.agentId !== entry.agentId && candidate.id !== entry.parentId)
      .slice(-2);

    for (const candidate of crossAgent) {
      push({
        id: `ctx:${candidate.id}->${entry.id}`,
        from: candidate.id,
        to: entry.id,
        kind: "spawned",
      });
    }
  }

  const discoveries = nodes.filter((node) => node.stage === "discovery");
  const failedExperiments = nodes.filter(
    (node) => node.stage === "experiment" && node.entry.metadata?.outcome === "refuted",
  );

  return {
    nodes,
    edges: [...edges.values()],
    stats: {
      hypotheses: nodes.filter((n) => n.stage === "hypothesis").length,
      experiments: nodes.filter((n) => n.stage === "experiment").length,
      discoveries: discoveries.length,
      verified: discoveries.filter((n) => (n.confidence ?? 0) >= 0.6).length,
      refuted: failedExperiments.length,
    },
  };
}

/**
 * Longest-path layering: a node sits one column to the right of everything it
 * depends on. Cycle-safe (falls back to the current depth on a loop).
 */
export function layerNodes(nodes: DiscoveryNode[], edges: DiscoveryEdge[]): DiscoveryNode[][] {
  const depth = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
  }

  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    if (depth.has(id)) return depth.get(id) as number;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const incoming = parents.get(id) ?? [];
    const value = incoming.length ? Math.max(...incoming.map(resolve)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  const grouped = new Map<number, DiscoveryNode[]>();
  for (const node of nodes) {
    const level = Math.min(resolve(node.id), 6);
    grouped.set(level, [...(grouped.get(level) ?? []), node]);
  }

  const maxLevel = grouped.size ? Math.max(...grouped.keys()) : 0;
  const columns: DiscoveryNode[][] = [];
  for (let level = 0; level <= maxLevel; level += 1) {
    columns.push((grouped.get(level) ?? []).sort((a, b) => a.iteration - b.iteration));
  }
  return columns;
}

export const STAGE_META: Record<
  DiscoveryNodeStage,
  { label: string; tone: Tone; icon: string }
> = {
  hypothesis: { label: "Hypothesis", tone: "violet", icon: "flask" },
  experiment: { label: "Experiment", tone: "cyan", icon: "beaker" },
  discovery: { label: "Key discovery", tone: "emerald", icon: "sparkle" },
  next: { label: "Next steps", tone: "slate", icon: "arrow" },
};
