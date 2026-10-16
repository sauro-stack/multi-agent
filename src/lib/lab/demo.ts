import "server-only";

import { startAgent } from "@/lib/engine/agent-loop";
import { roomId as newRoomId, agentId as newAgentId } from "@/lib/engine/ids";
import { createAgent, createRoom, listRooms, updateRoom } from "@/lib/lab/store";
import type { Agent, ProviderId, ResearchRoom } from "@/lib/types";

/**
 * Demo seeding.
 *
 * Everything here runs on the offline simulator, so the full loop — including
 * throttling and backoff — can be demonstrated without any provider key.
 */

export const DEMO_PRESETS = [
  {
    slug: "induction-heads",
    topic: "Mechanistic interpretability of induction heads in transformer circuits",
    objective:
      "Determine which attention head circuits implement in-context copying, and whether the mechanism generalises across model scales.",
  },
  {
    slug: "gnn-drug-discovery",
    topic: "Optimising graph neural networks for molecular property prediction in drug discovery",
    objective:
      "Find the representation and message-passing choices that maximise out-of-distribution accuracy on scaffold splits.",
  },
  {
    slug: "agentic-eval-leakage",
    topic: "Benchmark leakage in agentic evaluation harnesses",
    objective:
      "Quantify how much reported agent capability is explained by contamination between training corpora and eval sets.",
  },
] as const;

export const DEMO_LABELS = [
  {
    name: "Hypothesis Forge",
    province: "Generates falsifiable hypotheses and designs the first experiment for each.",
    provider: "simulated" as ProviderId,
    model: "lab-sim-1",
  },
  {
    name: "Replication Engine",
    province: "Independently re-runs claimed effects with different seeds and metrics.",
    provider: "simulated" as ProviderId,
    model: "lab-sim-1",
  },
  {
    name: "Adversarial Critic",
    province: "Hunts for confounds, metric artifacts and unreplicated claims.",
    provider: "simulated" as ProviderId,
    model: "lab-sim-1-fast",
  },
];

export interface SeedResult {
  room: ResearchRoom;
  agents: Agent[];
  seeded: boolean;
  reason?: string;
}

export function seedDemoRoom(input: {
  presetSlug?: string;
  topic?: string;
  objective?: string;
  createdBy: string;
  issuerSessionId: string | null;
  issuerProvider?: ProviderId;
  issuerModel?: string;
  includeIssuer?: boolean;
  rejoined?: ResearchRoom | null;
}): SeedResult {
  const preset = DEMO_PRESETS.find((p) => p.slug === input.presetSlug) ?? DEMO_PRESETS[0];
  const topic = input.topic?.trim() || preset.topic;
  const objective = input.objective?.trim() || preset.objective;

  const room =
    input.rejoined ??
    createRoom({
      id: newRoomId(),
      topic,
      objective,
      createdBy: input.createdBy,
      maxAgents: 6,
      iterationBudget: Number(process.env.LAB_DEMO_ITERATIONS ?? 14),
      cycleIntervalMs: Number(process.env.LAB_DEMO_CYCLE_MS ?? 7000),
    });

  if (input.rejoined) {
    updateRoom(room.id, { status: "ACTIVE" });
  }

  const agents: Agent[] = [];

  if (input.includeIssuer !== false) {
    agents.push(
      createAgent({
        id: newAgentId(),
        roomId: room.id,
        sessionId: input.issuerSessionId,
        name: input.createdBy,
        provider: input.issuerProvider ?? "simulated",
        model: input.issuerModel ?? "lab-sim-1",
      }),
    );
  }

  for (const label of DEMO_LABELS) {
    if (label.name === input.createdBy) continue;
    agents.push(
      createAgent({
        id: newAgentId(),
        roomId: room.id,
        sessionId: null, // no credential needed: the simulator is keyless
        name: label.name,
        provider: label.provider,
        model: label.model,
      }),
    );
  }

  for (const agent of agents) startAgent(agent.id);

  return { room: updateRoom(room.id, {}) ?? room, agents, seeded: true };
}

/** True when the database has no rooms yet — used for first-load seeding. */
export function labIsEmpty(): boolean {
  return listRooms(1).length === 0;
}
