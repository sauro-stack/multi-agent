"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  CircleDot,
  Cpu,
  Layers,
  Plus,
  RefreshCw,
  RadioTower,
  ServerCog,
  Sparkles,
  Waves,
  X,
  Zap,
} from "lucide-react";

import { AgentGrid } from "@/components/lab/agent-grid";
import { DiscoveryGraphPanel } from "@/components/lab/discovery-graph";
import { LiveFeed } from "@/components/lab/live-feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS, SELECTABLE_PROVIDERS } from "@/lib/providers/config";
import { postJson, useNow, useRoomStream } from "@/lib/hooks/use-room-stream";
import type { Agent, LogEntry, ResearchRoom } from "@/lib/types";
import { cn, formatDuration, timeAgo, truncate } from "@/lib/utils";

interface RuntimeInfo {
  runtime: string;
  booted: boolean;
  ticks: number;
  lastTickAt: string | null;
  inflight: number;
  queuedJobs: number;
  lastError: string | null;
}

interface HealthResponse {
  runtime: RuntimeInfo;
  streams: number;
  summary: string;
}

const CONNECTION_META = {
  connecting: { label: "connecting", tone: "slate" as const, pulse: true },
  live: { label: "live", tone: "active" as const, pulse: true },
  reconnecting: { label: "reconnecting", tone: "warn" as const, pulse: true },
  closed: { label: "closed", tone: "error" as const, pulse: false },
};

export function LabDashboard({
  initial,
}: {
  initial: { room: ResearchRoom; agents: Agent[]; entries: LogEntry[] };
}) {
  const stream = useRoomStream(initial);
  const now = useNow(1000);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) return;
      setHealth((await response.json()) as HealthResponse);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), 8000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  const stats = useMemo(() => {
    const discoveries = stream.entries.filter((entry) => entry.kind === "key_discovery").length;
    const throttles = stream.agents.reduce((sum, agent) => sum + agent.throttleTotal, 0);
    const contributions = stream.agents.reduce((sum, agent) => sum + agent.contributions, 0);
    const active = stream.agents.filter(
      (agent) => agent.status === "RESEARCHING" || agent.status === "IDLE",
    ).length;
    const parked = stream.agents.filter((agent) => agent.status === "PAUSED_RATE_LIMIT").length;
    return { discoveries, throttles, contributions, active, parked };
  }, [stream.agents, stream.entries]);

  const tickNow = async () => {
    setBusy(true);
    try {
      await postJson("/api/tick", { fanOut: true, await: false, limit: 12 });
      await refreshHealth();
    } catch {
      /* surfaced by health polling */
    } finally {
      setBusy(false);
    }
  };

  const connection = CONNECTION_META[stream.connection];

  return (
    <div className="mx-auto max-w-[1680px] px-4 py-5 lg:px-6">
      {/* ---------------------------------------------------------------- */}
      {/* Notifications                                                     */}
      {/* ---------------------------------------------------------------- */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[330px] flex-col gap-2">
        <AnimatePresence>
          {stream.notifications.map((notification) => (
            <motion.div
              key={notification.id}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 30 }}
              className={cn(
                "pointer-events-auto rounded-md border bg-lab-panel/95 px-3 py-2 shadow-xl backdrop-blur",
                notification.tone === "warn"
                  ? "border-lab-amber/50"
                  : notification.tone === "error"
                    ? "border-lab-red/50"
                    : "border-lab-border",
              )}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    notification.tone === "warn" ? "text-lab-amber" : "text-lab-red",
                  )}
                />
                <p className="font-mono text-[11px] leading-snug text-lab-text">{notification.message}</p>
                <button
                  type="button"
                  className="ml-auto text-lab-muted hover:text-lab-text"
                  onClick={() => stream.dismissNotification(notification.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <header className="rounded-lg border border-lab-border bg-lab-panel/60 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-lab-muted">
              <RadioTower className="size-3.5 text-lab-accent" />
              <Link href="/" className="flex items-center gap-1 transition-colors hover:text-lab-accent">
                <ChevronLeft className="size-3" /> all rooms
              </Link>
              <span className="opacity-40">/</span>
              <span>{stream.room.slug}</span>
            </div>
            <h1 className="mt-1.5 max-w-4xl text-lg font-semibold leading-tight text-white lg:text-xl">
              {stream.room.topic}
            </h1>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-lab-muted">{stream.room.objective}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connection.tone}>
              <span className={cn("size-1.5 rounded-full bg-current", connection.pulse && "animate-lab-pulse")} />
              {connection.label}
            </Badge>
            <Badge tone={stream.room.status === "ACTIVE" ? "active" : "warn"}>{stream.room.status}</Badge>
            <Button size="sm" variant="secondary" disabled={busy} onClick={tickNow}>
              <Zap className="size-3" /> tick now
            </Button>
            <Button size="sm" variant="ghost" onClick={stream.reconnect}>
              <RefreshCw className="size-3" /> reconnect
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat icon={Cpu} label="agents" value={`${stats.active}/${stream.agents.length}`} hint="active / total" />
          <Stat icon={Layers} label="entries" value={String(stream.entries.length)} hint="in view" />
          <Stat icon={Sparkles} label="discoveries" value={String(stats.discoveries)} hint="key findings" />
          <Stat
            icon={Activity}
            label="contributions"
            value={String(stats.contributions)}
            hint={`${stream.events} stream events`}
          />
          <Stat
            icon={AlertTriangle}
            label="throttles"
            value={String(stats.throttles)}
            hint={stats.parked ? `${stats.parked} parked now` : "none parked"}
            tone={stats.parked ? "warn" : "default"}
          />
          <Stat
            icon={ServerCog}
            label="queue"
            value={String(health?.runtime.queuedJobs ?? "—")}
            hint={`${health?.runtime.inflight ?? 0} in flight · ${health?.streams ?? 0} streams`}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-lab-muted">
          <span>opened by {stream.room.createdBy}</span>
          <span>cycle interval {formatDuration(stream.room.cycleIntervalMs)}</span>
          <span>budget {stream.room.iterationBudget} cycles/agent</span>
          <span>max {stream.room.maxAgents} agents</span>
          <span>
            last event {stream.lastEventAt ? timeAgo(new Date(stream.lastEventAt).toISOString()) : "—"}
          </span>
          {health ? <span className="truncate">{health.summary}</span> : null}
        </div>
      </header>

      <div className="mt-5 space-y-5">
        <AgentGrid
          agents={stream.agents}
          iterationBudget={stream.room.iterationBudget}
          now={now}
          onChanged={() => {
            void refreshHealth();
            stream.reconnect();
          }}
          onSelect={setAgentFilter}
          selectedAgentId={agentFilter}
        />

        <div className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
          <LiveFeed
            entries={stream.entries}
            agentFilter={agentFilter}
            onClearAgentFilter={() => setAgentFilter(null)}
          />

          <div className="space-y-5">
            <DiscoveryGraphPanel graph={stream.graph} selectedAgentId={agentFilter} />
            <RoomControls room={stream.room} />
            <JoinPanel room={stream.room} agentCount={stream.agents.length} onJoined={stream.reconnect} />
          </div>
        </div>
      </div>

      {stream.error ? (
        <div className="mt-5 rounded-md border border-lab-red/40 bg-lab-red/[0.06] px-4 py-2 font-mono text-[11px] text-lab-red">
          {stream.error}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        tone === "warn" ? "border-lab-amber/40 bg-lab-amber/[0.06]" : "border-lab-border bg-lab-void/50",
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-lab-muted">
        <Icon className="size-3" />
        {label}
      </div>
      <div className="mt-1 font-mono text-base text-lab-text">{value}</div>
      {hint ? <div className="font-mono text-[9.5px] text-lab-muted/70">{hint}</div> : null}
    </div>
  );
}

function RoomControls({ room }: { room: ResearchRoom }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const setStatus = async (status: "ACTIVE" | "PAUSED") => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      setMessage(`Room is now ${status}`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-3 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          <CircleDot className="size-3.5" /> room control
        </h2>
      </div>
      <div className="space-y-3 px-3 py-3">
        <p className="text-xs leading-relaxed text-lab-muted">
          Pausing the room stops new cycles from being scheduled. In-flight cycles finish, parked agents keep their
          scheduled resumes.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy || room.status === "ACTIVE"} onClick={() => setStatus("ACTIVE")}>
            resume room
          </Button>
          <Button size="sm" variant="amber" disabled={busy || room.status === "PAUSED"} onClick={() => setStatus("PAUSED")}>
            pause room
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await postJson("/api/tick", { fanOut: true, roomId: room.id, limit: 12 });
                setMessage("Fan-out enqueued a cycle for every idle agent.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Waves className="size-3" /> fan out
          </Button>
        </div>
        {message ? <p className="font-mono text-[10px] text-lab-muted">{message}</p> : null}
      </div>
    </Card>
  );
}

function JoinPanel({
  room,
  agentCount,
  onJoined,
}: {
  room: ResearchRoom;
  agentCount: number;
  onJoined: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("simulated");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = agentCount >= room.maxAgents;
  const config = PROVIDERS[provider as keyof typeof PROVIDERS];

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/rooms/${room.id}/agents`, {
        name: name.trim() || undefined,
        provider,
        model: config?.defaultModel,
      });
      setName("");
      onJoined();
    } catch (caught) {
      setError(caught instanceof Error ? truncate(caught.message, 160) : "Join failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-3 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          <Plus className="size-3.5" /> add an agent
        </h2>
        <Badge tone={full ? "warn" : "slate"} className="ml-auto">
          {agentCount}/{room.maxAgents}
        </Badge>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="space-y-1.5">
          <Label htmlFor="join-name">Agent name (optional)</Label>
          <Input
            id="join-name"
            value={name}
            placeholder="Replication Node"
            disabled={full || busy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={setProvider} disabled={full || busy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTABLE_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVIDERS[id].label}
                  {PROVIDERS[id].requiresKey ? "" : " (no key)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="font-mono text-[10px] leading-relaxed text-lab-muted">
          {config?.note}
          {config?.requiresKey
            ? ` · uses the key from your session, or ${config.apiKeyEnvVar} on the server`
            : " · runs offline, no credential needed"}
        </p>

        {error ? <p className="font-mono text-[10px] text-lab-red">{error}</p> : null}

        <Button className="w-full" disabled={full || busy} onClick={join}>
          {full ? "room is full" : busy ? "joining…" : "join & start iterating"}
        </Button>
      </div>
    </Card>
  );
}
