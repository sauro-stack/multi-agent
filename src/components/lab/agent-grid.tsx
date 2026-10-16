"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, Bot, Gauge, Pause, Play, Trash2, Zap } from "lucide-react";

import { AgentStatusBadge } from "@/components/lab/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PROVIDERS } from "@/lib/providers/config";
import type { Agent } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

export function AgentGrid({
  agents,
  iterationBudget,
  now,
  onChanged,
  onSelect,
  selectedAgentId,
}: {
  agents: Agent[];
  iterationBudget: number;
  now: number;
  onChanged: () => void;
  onSelect: (agentId: string | null) => void;
  selectedAgentId: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (agentId: string, action: "resume" | "pause" | "remove") => {
    setBusy(agentId);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${response.status})`);
      }
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          <Bot className="size-3.5" /> Agent swarm · {agents.length}
        </h2>
        {error ? <span className="font-mono text-[10px] text-lab-red">{error}</span> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence initial={false}>
          {agents.map((agent) => {
            const config = PROVIDERS[agent.provider];
            const throttled = agent.status === "PAUSED_RATE_LIMIT";
            const remaining = throttled && agent.resumeAt ? new Date(agent.resumeAt).getTime() - now : null;
            const progress = iterationBudget ? (agent.iteration / iterationBudget) * 100 : 0;

            return (
              <motion.div
                key={agent.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.22 }}
              >
                <Card
                  className={cn(
                    "relative overflow-hidden p-3 transition-colors",
                    selectedAgentId === agent.id && "border-lab-accent/50",
                    throttled && "border-lab-amber/40",
                    agent.status === "ERROR" && "border-lab-red/40",
                  )}
                >
                  {throttled ? (
                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-lab-amber to-transparent" />
                  ) : null}
                  {agent.status === "RESEARCHING" ? (
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-lab-accent/10 to-transparent" />
                  ) : null}

                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(selectedAgentId === agent.id ? null : agent.id)}
                      className="min-w-0 text-left"
                    >
                      <div className="truncate font-medium text-lab-text hover:text-white">{agent.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-lab-muted">
                        <span className="truncate">{config?.label ?? agent.provider}</span>
                        <span className="opacity-40">/</span>
                        <span className="truncate">{agent.model}</span>
                      </div>
                    </button>
                    <AgentStatusBadge agent={agent} now={now} />
                  </div>

                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between font-mono text-[10px] text-lab-muted">
                      <span>cycle {agent.iteration}/{iterationBudget}</span>
                      <span>{agent.contributions} contributions</span>
                    </div>
                    <Progress
                      value={progress}
                      tone={throttled ? "bg-lab-amber" : agent.status === "ERROR" ? "bg-lab-red" : "bg-lab-accent"}
                    />
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {agent.throttleTotal > 0 ? (
                      <Badge tone="warn" title={`${agent.throttleTotal} throttle event(s)`}>
                        <Zap className="size-3" /> {agent.throttleTotal} throttled
                      </Badge>
                    ) : (
                      <Badge tone="slate">
                        <Gauge className="size-3" /> no throttles
                      </Badge>
                    )}
                    {throttled && remaining !== null ? (
                      <Badge tone="amber">
                        backoff {formatDuration(agent.backoffMs)} · {remaining > 0 ? `${formatDuration(remaining)} left` : "resuming"}
                      </Badge>
                    ) : null}
                    {agent.status === "RESEARCHING" ? (
                      <Badge tone="active">
                        <Activity className="size-3 animate-pulse" /> thinking
                      </Badge>
                    ) : null}
                  </div>

                  {agent.lastError ? (
                    <p className="mt-2 line-clamp-2 font-mono text-[10px] text-lab-amber/90" title={agent.lastError}>
                      {agent.lastError}
                    </p>
                  ) : null}

                  <div className="mt-3 flex items-center gap-1.5 border-t border-lab-border/70 pt-2">
                    {throttled ? (
                      <Button
                        size="sm"
                        variant="amber"
                        disabled={busy === agent.id}
                        onClick={() => act(agent.id, "resume")}
                      >
                        <Play className="size-3" /> resume now
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === agent.id || agent.status === "COMPLETED"}
                        onClick={() => act(agent.id, "pause")}
                      >
                        <Pause className="size-3" /> pause
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      disabled={busy === agent.id}
                      onClick={() => act(agent.id, "remove")}
                      title="Remove this agent from the room"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {!agents.length ? (
          <Card className="col-span-full border-dashed p-6 text-center font-mono text-xs text-lab-muted">
            No agents in this room yet.
          </Card>
        ) : null}
      </div>
    </div>
  );
}
