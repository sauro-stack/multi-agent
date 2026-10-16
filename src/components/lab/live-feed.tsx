"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownToLine, FlaskConical, Pause, Play, ScrollText, Sparkles, Terminal } from "lucide-react";

import { CodeBlock, Markdown } from "@/components/lab/markdown";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PROVIDERS } from "@/lib/providers/config";
import type { LogEntry, LogEntryKind } from "@/lib/types";
import { cn, formatClock, percent, truncate } from "@/lib/utils";

const KIND_META: Record<
  LogEntryKind,
  {
    label: string;
    tone: BadgeProps["tone"];
    accent: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  thought_process: { label: "thought", tone: "violet", accent: "border-l-lab-violet", icon: Terminal },
  experiment_run: { label: "experiment", tone: "cyan", accent: "border-l-lab-cyan", icon: FlaskConical },
  key_discovery: { label: "discovery", tone: "emerald", accent: "border-l-lab-accent", icon: Sparkles },
  next_steps: { label: "next steps", tone: "slate", accent: "border-l-lab-border", icon: ArrowDownToLine },
  system: { label: "system", tone: "default", accent: "border-l-lab-border", icon: ScrollText },
  rate_limit: { label: "rate limit", tone: "amber", accent: "border-l-lab-amber", icon: Pause },
  error: { label: "error", tone: "error", accent: "border-l-lab-red", icon: ScrollText },
};

const FILTERS: { id: string; label: string; kinds: LogEntryKind[] }[] = [
  { id: "all", label: "all", kinds: [] },
  { id: "thoughts", label: "thoughts", kinds: ["thought_process"] },
  { id: "experiments", label: "experiments", kinds: ["experiment_run"] },
  { id: "discoveries", label: "discoveries", kinds: ["key_discovery"] },
  { id: "next", label: "next steps", kinds: ["next_steps"] },
  { id: "health", label: "rate limits", kinds: ["rate_limit", "error", "system"] },
];

export function LiveFeed({
  entries,
  agentFilter,
  onClearAgentFilter,
}: {
  entries: LogEntry[];
  agentFilter: string | null;
  onClearAgentFilter: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const kinds = FILTERS.find((item) => item.id === filter)?.kinds ?? [];
    return entries.filter((entry) => {
      if (agentFilter && entry.agentId !== agentFilter) return false;
      if (kinds.length && !kinds.includes(entry.kind)) return false;
      return true;
    });
  }, [entries, filter, agentFilter]);

  useEffect(() => {
    if (!follow) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [visible.length, follow]);

  const counts = useMemo(() => {
    const map = new Map<LogEntryKind, number>();
    for (const entry of entries) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1);
    return map;
  }, [entries]);

  return (
    <Card className="flex min-h-[680px] flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-lab-border px-3 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          <Terminal className="size-3.5" /> live research feed
        </h2>

        <Tabs value={filter} onValueChange={setFilter} className="ml-1">
          <TabsList>
            {FILTERS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {agentFilter ? (
          <Badge tone="active" className="cursor-pointer" onClick={onClearAgentFilter}>
            filtered by agent · clear ✕
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-lab-muted">
            {visible.length}/{entries.length} entries
          </span>
          <Button
            size="sm"
            variant={follow ? "secondary" : "ghost"}
            onClick={() => setFollow((value) => !value)}
            title="Auto-scroll as new entries arrive"
          >
            {follow ? <Pause className="size-3" /> : <Play className="size-3" />}
            follow
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onWheel={() => setFollow(false)}
        className="grid-noise relative flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        <AnimatePresence initial={false}>
          {visible.map((entry) => {
            const meta = KIND_META[entry.kind];
            const Icon = meta.icon;
            const provider = entry.provider ? PROVIDERS[entry.provider] : null;

            return (
              <motion.article
                key={entry.seq}
                layout="position"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={cn(
                  "rounded-md border border-lab-border/80 border-l-2 bg-lab-panel/60 px-3 py-2.5",
                  meta.accent,
                  entry.kind === "rate_limit" && "bg-lab-amber/[0.04]",
                  entry.kind === "error" && "bg-lab-red/[0.04]",
                  entry.kind === "key_discovery" && "bg-lab-accent/[0.035]",
                )}
              >
                <header className="flex flex-wrap items-center gap-2">
                  <Badge tone={meta.tone}>
                    <Icon className="size-3" />
                    {meta.label}
                  </Badge>
                  <span className="font-mono text-[11px] font-medium text-lab-text">{entry.agentName}</span>
                  {provider ? (
                    <span className="font-mono text-[10px] text-lab-muted" title={provider.label}>
                      {provider.label}
                    </span>
                  ) : null}
                  <span className="font-mono text-[10px] text-lab-muted/70">#{entry.seq}</span>
                  <span className="ml-auto font-mono text-[10px] text-lab-muted">{formatClock(entry.createdAt)}</span>
                </header>

                <h3 className="mt-1.5 text-[13px] font-medium leading-snug text-[#e8f1fb]">{entry.title}</h3>

                {entry.kind === "key_discovery" && entry.confidence !== null ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge tone={entry.confidence >= 0.75 ? "active" : entry.confidence >= 0.5 ? "cyan" : "slate"}>
                      confidence {percent(entry.confidence)}
                    </Badge>
                    {typeof entry.metadata?.outcome === "string" ? (
                      <Badge tone={entry.metadata.outcome === "refuted" ? "error" : "default"}>
                        {String(entry.metadata.outcome)}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}

                <Markdown content={entry.content} className="mt-1.5 text-lab-text/90" />

                {entry.code ? (
                  <CodeBlock code={entry.code} language={entry.codeLanguage} className="mt-2" />
                ) : null}

                <footer className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-lab-muted/70">
                  <span>cycle {entry.iteration}</span>
                  <span>{entry.latencyMs}ms</span>
                  <span>
                    {entry.tokensIn + entry.tokensOut} tok ({entry.tokensIn}↑ {entry.tokensOut}↓)
                  </span>
                  {entry.parentId ? (
                    <span title={`Builds on ${entry.parentId}`}>↳ linked to parent</span>
                  ) : null}
                  {typeof entry.metadata?.credentialSource === "string" ? (
                    <span>via {String(entry.metadata.credentialSource)}</span>
                  ) : null}
                </footer>
              </motion.article>
            );
          })}
        </AnimatePresence>

        {!visible.length ? (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-center">
            <Terminal className="size-6 text-lab-muted/50" />
            <p className="font-mono text-xs text-lab-muted">
              {entries.length ? "No entries match this filter." : "Waiting for the first autonomous cycle…"}
            </p>
            {entries.length ? null : (
              <p className="max-w-sm font-mono text-[10px] text-lab-muted/70">
                Agents publish here the moment they finish a cycle. Structured kinds: thought_process,
                experiment_run, key_discovery, next_steps.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-lab-border px-3 py-1.5 font-mono text-[10px] text-lab-muted">
        {(["thought_process", "experiment_run", "key_discovery", "next_steps", "rate_limit", "error"] as LogEntryKind[]).map(
          (kind) => (
            <span key={kind} className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", dotColor(kind))} />
              {truncate(KIND_META[kind].label, 12)} {counts.get(kind) ?? 0}
            </span>
          ),
        )}
      </div>
    </Card>
  );
}

function dotColor(kind: LogEntryKind): string {
  switch (kind) {
    case "key_discovery":
      return "bg-lab-accent";
    case "experiment_run":
      return "bg-lab-cyan";
    case "thought_process":
      return "bg-lab-violet";
    case "rate_limit":
      return "bg-lab-amber";
    case "error":
      return "bg-lab-red";
    default:
      return "bg-lab-muted";
  }
}
