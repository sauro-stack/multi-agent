"use client";

import { AlertTriangle, CheckCircle2, Circle, Loader2, PauseCircle, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { AGENT_STATUS_META, type Agent, type AgentStatus } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";

const ICONS: Record<AgentStatus, React.ComponentType<{ className?: string }>> = {
  IDLE: Circle,
  RESEARCHING: Loader2,
  PAUSED_RATE_LIMIT: PauseCircle,
  COMPLETED: CheckCircle2,
  ERROR: XCircle,
};

/**
 * Renders the agent status. When the agent is parked on a throttle it shows a
 * live countdown to the scheduled resume: `rate-limited (retrying in 42s)`.
 */
export function AgentStatusBadge({
  agent,
  now,
  className,
}: {
  agent: Agent;
  now: number;
  className?: string;
}) {
  const meta = AGENT_STATUS_META[agent.status];
  const Icon = ICONS[agent.status];

  if (agent.status === "PAUSED_RATE_LIMIT") {
    const remaining = agent.resumeAt ? new Date(agent.resumeAt).getTime() - now : null;
    // A null resumeAt is deliberate: either a human paused it, or the backoff
    // attempts were exhausted. Neither resumes on its own.
    const label =
      agent.resumeAt === null
        ? "rate-limited (manual resume)"
        : remaining !== null && remaining > 0
          ? `rate-limited (retrying in ${formatDuration(remaining)})`
          : "rate-limited (resume imminent)";

    return (
      <Badge tone="warn" className={cn("gap-1.5", className)} title={agent.lastError ?? meta.description}>
        <AlertTriangle className="size-3 animate-lab-pulse" />
        {label}
      </Badge>
    );
  }

  return (
    <Badge tone={meta.tone} className={className} title={meta.description}>
      <Icon className={cn("size-3", agent.status === "RESEARCHING" && "animate-spin")} />
      {meta.label}
    </Badge>
  );
}
