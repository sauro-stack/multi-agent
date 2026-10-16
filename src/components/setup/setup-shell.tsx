"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Boxes,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS, SELECTABLE_PROVIDERS } from "@/lib/providers/config";
import { postJson } from "@/lib/hooks/use-room-stream";
import type { ProviderId, RoomSummary, SessionPublic } from "@/lib/types";
import { cn, timeAgo, truncate } from "@/lib/utils";

interface PresetsResponse {
  presets: { slug: string; topic: string; objective: string }[];
  rooms: RoomSummary[];
}

export function SetupShell() {
  const router = useRouter();
  const [session, setSession] = useState<SessionPublic | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [presets, setPresets] = useState<PresetsResponse["presets"]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [sessionResponse, roomsResponse] = await Promise.all([
      fetch("/api/session", { cache: "no-store" }),
      fetch("/api/rooms", { cache: "no-store" }),
    ]);
    const sessionData = (await sessionResponse.json()) as { session: SessionPublic | null };
    const roomsData = (await roomsResponse.json()) as { rooms: RoomSummary[] };
    setSession(sessionData.session);
    setRooms(roomsData.rooms ?? []);
    try {
      const presetsResponse = await fetch("/api/demo", { cache: "no-store" });
      const presetData = (await presetsResponse.json()) as PresetsResponse;
      setPresets(presetData.presets ?? []);
    } catch {
      setPresets([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-[1240px] px-5 py-10 lg:py-14">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-lab-muted">
          <Boxes className="size-3.5 text-lab-accent" />
          multi-agent research infrastructure
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white lg:text-[40px]">
          Autonomous Research Lab
        </h1>
        <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-lab-muted">
          Point a swarm of agents at one hard question. Each one runs its own background loop — hypothesise, design an
          experiment, publish a finding — while the room streams every thought live. When a provider throttles one
          agent, that agent sleeps with an exact backoff and the rest of the swarm keeps working.
        </p>
      </motion.div>

      <div className="mt-9 grid gap-6 lg:grid-cols-[1.05fr_1fr]">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          className="space-y-6"
        >
          <SessionPanel session={session} onChanged={load} />
          <DemoPanel presets={presets} disabled={!session} onLaunched={(roomId) => router.push(`/room/${roomId}`)} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1 }}
          className="space-y-6"
        >
          <CreateRoomPanel disabled={!session} onCreated={(roomId) => router.push(`/room/${roomId}`)} />
          <RoomList rooms={rooms} loading={loading} />
        </motion.div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

function SessionPanel({ session, onChanged }: { session: SessionPublic | null; onChanged: () => void }) {
  const [agentName, setAgentName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("simulated");
  const [model, setModel] = useState(PROVIDERS.simulated.defaultModel);
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = PROVIDERS[provider];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/session", { agentName, provider, model, apiKey });
      setApiKey("");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? truncate(caught.message, 220) : "Failed to create session");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    await fetch("/api/session", { method: "DELETE" });
    setBusy(false);
    onChanged();
  };

  if (session) {
    return (
      <Card>
        <div className="flex items-center gap-2 border-b border-lab-border px-4 py-2.5">
          <ShieldCheck className="size-3.5 text-lab-accent" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">active session</h2>
          <Badge tone="active" className="ml-auto">
            {session.provider}
          </Badge>
        </div>
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-lab-muted">agent name</div>
              <div className="text-sm text-lab-text">{session.agentName}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-lab-muted">model</div>
              <div className="font-mono text-sm text-lab-text">{session.model}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-lab-muted">credential</div>
              <div className="font-mono text-sm text-lab-text">
                {session.hasKey ? session.keyHint : session.keySource === "simulated" ? "keyless simulator" : "server env"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-lab-muted">expires</div>
              <div className="font-mono text-sm text-lab-text">{timeAgo(session.expiresAt).replace(" ago", "")} left</div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded border border-lab-border bg-lab-void/50 px-3 py-2">
            <KeyRound className="mt-0.5 size-3.5 shrink-0 text-lab-accent" />
            <p className="font-mono text-[10px] leading-relaxed text-lab-muted">
              Your key is encrypted with AES-256-GCM before it touches the database, is decrypted only inside the
              server-side agent cycle that calls the provider, and is never returned to the browser or written to a log.
              {session.hasKey ? ` Stored as ${session.keyHint}.` : ""}
            </p>
          </div>

          <Button size="sm" variant="ghost" disabled={busy} onClick={revoke}>
            end session &amp; destroy key
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-4 py-2.5">
        <KeyRound className="size-3.5 text-lab-accent" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">1 · register an agent</h2>
      </div>

      <div className="space-y-3.5 px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input
              id="agent-name"
              value={agentName}
              placeholder="Lead Investigator"
              onChange={(event) => setAgentName(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select
              value={provider}
              onValueChange={(value) => {
                const next = value as ProviderId;
                setProvider(next);
                setModel(PROVIDERS[next].defaultModel);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SELECTABLE_PROVIDERS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {PROVIDERS[id].label}
                    {PROVIDERS[id].requiresKey ? "" : " · no key"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {config.models.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="api-key">API key {config.requiresKey ? "" : "(not required)"}</Label>
            <div className="relative">
              <Input
                id="api-key"
                type={reveal ? "text" : "password"}
                value={apiKey}
                disabled={!config.requiresKey}
                placeholder={config.requiresKey ? config.apiKeyEnvVar : "simulator needs no key"}
                onChange={(event) => setApiKey(event.target.value)}
                className="pr-9"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-lab-muted hover:text-lab-text"
                onClick={() => setReveal((value) => !value)}
                tabIndex={-1}
              >
                {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </div>
        </div>

        <p className="font-mono text-[10px] leading-relaxed text-lab-muted">
          {config.note}
          {config.requiresKey
            ? ` Uses ${config.apiKeyEnvVar} if the field is left empty and the server has one configured.`
            : " The Lab Simulator replays the full loop offline and injects real 429 semantics so rate-limit handling is observable without provider spend."}
        </p>

        {error ? (
          <p className="rounded border border-lab-red/40 bg-lab-red/[0.06] px-3 py-2 font-mono text-[10px] text-lab-red">
            {error}
          </p>
        ) : null}

        <Button className="w-full" disabled={busy || agentName.trim().length < 2} onClick={submit}>
          {busy ? "creating session…" : "create encrypted session"}
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                       */
/* -------------------------------------------------------------------------- */

function DemoPanel({
  presets,
  disabled,
  onLaunched,
}: {
  presets: { slug: string; topic: string; objective: string }[];
  disabled: boolean;
  onLaunched: (roomId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const launch = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      const result = await postJson<{ room: { id: string } }>("/api/demo", { presetSlug: slug, rejoin: true });
      onLaunched(result.room.id);
    } catch (caught) {
      setError(caught instanceof Error ? truncate(caught.message, 200) : "Launch failed");
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-4 py-2.5">
        <Rocket className="size-3.5 text-lab-accent" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">2 · or launch a swarm</h2>
        <Badge tone="slate" className="ml-auto">
          keyless · simulator
        </Badge>
      </div>

      <div className="space-y-2.5 px-4 py-3.5">
        <p className="text-xs leading-relaxed text-lab-muted">
          Spins up four agents on the offline simulator against a preset topic — including you. Throttles are injected
          every third cycle so the pause, backoff and resume path is visible within seconds.
        </p>

        {(presets.length ? presets : FALLBACK_PRESETS).map((preset) => (
          <button
            key={preset.slug}
            type="button"
            disabled={disabled || Boolean(busy)}
            onClick={() => {
              setSelected(preset.slug);
              void launch(preset.slug);
            }}
            className={cn(
              "w-full rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              selected === preset.slug
                ? "border-lab-accent/60 bg-lab-accent/[0.07]"
                : "border-lab-border bg-lab-void/40 hover:border-lab-accent/40",
            )}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 shrink-0 text-lab-accent" />
              <span className="text-[13px] font-medium text-lab-text">{preset.topic}</span>
            </div>
            <p className="mt-1 pl-5 font-mono text-[10px] leading-relaxed text-lab-muted">
              {truncate(preset.objective, 150)}
            </p>
            {busy === preset.slug ? (
              <p className="mt-1 pl-5 font-mono text-[10px] text-lab-accent">seeding agents…</p>
            ) : null}
          </button>
        ))}

        {disabled ? (
          <p className="font-mono text-[10px] text-lab-amber">
            Create a session above first — even the simulator path needs an agent identity.
          </p>
        ) : null}
        {error ? <p className="font-mono text-[10px] text-lab-red">{error}</p> : null}
      </div>
    </Card>
  );
}

const FALLBACK_PRESETS = [
  {
    slug: "induction-heads",
    topic: "Mechanistic interpretability of induction heads in transformer circuits",
    objective: "Determine which attention head circuits implement in-context copying across model scales.",
  },
  {
    slug: "gnn-drug-discovery",
    topic: "Optimising graph neural networks for molecular property prediction in drug discovery",
    objective: "Find the message-passing choices that maximise out-of-distribution accuracy on scaffold splits.",
  },
];

/* -------------------------------------------------------------------------- */
/* Create room                                                                */
/* -------------------------------------------------------------------------- */

function CreateRoomPanel({
  disabled,
  onCreated,
}: {
  disabled: boolean;
  onCreated: (roomId: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [objective, setObjective] = useState("");
  const [maxAgents, setMaxAgents] = useState("4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await postJson<{ room: { id: string } }>("/api/rooms", {
        topic,
        objective,
        maxAgents: Number(maxAgents),
      });
      onCreated(result.room.id);
    } catch (caught) {
      setError(caught instanceof Error ? truncate(caught.message, 200) : "Failed");
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-4 py-2.5">
        <Plus className="size-3.5 text-lab-accent" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">open your own room</h2>
      </div>

      <div className="space-y-3.5 px-4 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="topic">Research topic</Label>
          <Input
            id="topic"
            value={topic}
            placeholder="Sparse attention routing in long-context retrieval"
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="objective">Objective — what would count as a finding?</Label>
          <Textarea
            id="objective"
            value={objective}
            placeholder="Produce a reproducible ordering of routing strategies by retrieval accuracy, with negative results recorded."
            onChange={(event) => setObjective(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Max agents in room</Label>
          <Select value={maxAgents} onValueChange={setMaxAgents}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["2", "3", "4", "5", "6", "8"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value} agents
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error ? <p className="font-mono text-[10px] text-lab-red">{error}</p> : null}

        <Button
          className="w-full"
          variant="secondary"
          disabled={disabled || busy || topic.trim().length < 6}
          onClick={create}
        >
          {busy ? "creating…" : "create room & start researching"}
        </Button>
        {disabled ? (
          <p className="font-mono text-[10px] text-lab-amber">Register an agent first.</p>
        ) : null}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Room list                                                                  */
/* -------------------------------------------------------------------------- */

function RoomList({ rooms, loading }: { rooms: RoomSummary[]; loading: boolean }) {
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-lab-border px-4 py-2.5">
        <Users className="size-3.5 text-lab-accent" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          active research rooms
        </h2>
        <Badge tone="slate" className="ml-auto">
          {rooms.length}
        </Badge>
      </div>

      <div className="divide-y divide-lab-border/70">
        {loading ? (
          <p className="px-4 py-4 font-mono text-[11px] text-lab-muted">loading…</p>
        ) : rooms.length ? (
          rooms.map((room) => (
            <a
              key={room.id}
              href={`/room/${room.id}`}
              className="block px-4 py-3 transition-colors hover:bg-white/[0.025]"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-lab-text">{truncate(room.topic, 74)}</span>
                <Badge tone={room.status === "ACTIVE" ? "active" : "warn"} className="ml-auto shrink-0">
                  {room.status}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-lab-muted">
                <span className="flex items-center gap-1">
                  <Cpu className="size-3" /> {room.activeAgentCount}/{room.agentCount} agents
                </span>
                <span>{room.entryCount} entries</span>
                <span>{room.discoveryCount} discoveries</span>
                <span>updated {timeAgo(room.lastActivityAt ?? room.updatedAt)}</span>
              </div>
            </a>
          ))
        ) : (
          <p className="px-4 py-6 text-center font-mono text-[11px] text-lab-muted">
            No rooms yet. Launch a swarm or open your own.
          </p>
        )}
      </div>
    </Card>
  );
}
