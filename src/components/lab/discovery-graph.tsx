"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { GitBranch, Minus, Plus, Waypoints } from "lucide-react";

import { Markdown } from "@/components/lab/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { STAGE_META, layerNodes } from "@/lib/discovery";
import type { DiscoveryEdge, DiscoveryGraph, DiscoveryNodeStage } from "@/lib/types";
import { cn, formatClock, percent } from "@/lib/utils";

const NODE_W = 172;
const NODE_H = 46;
const COL_GAP = 52;
const ROW_GAP = 14;
const PAD_X = 22;
const PAD_Y = 26;

const STAGE_COLOR: Record<DiscoveryNodeStage, { stroke: string; fill: string; text: string }> = {
  hypothesis: { stroke: "#a78bfa", fill: "rgba(167,139,250,0.10)", text: "#c4b5fd" },
  experiment: { stroke: "#4cc9f0", fill: "rgba(76,201,240,0.10)", text: "#93dcf7" },
  discovery: { stroke: "#35e0a1", fill: "rgba(53,224,161,0.12)", text: "#7ff0c4" },
  next: { stroke: "#465a72", fill: "rgba(125,142,163,0.08)", text: "#93a6bd" },
};

const EDGE_STYLE: Record<DiscoveryEdge["kind"], { stroke: string; dash?: string; width: number }> = {
  continued: { stroke: "#3a4c63", width: 1.2 },
  spawned: { stroke: "#4cc9f0", dash: "4 4", width: 1 },
  verified: { stroke: "#35e0a1", width: 1.6 },
  contradicted: { stroke: "#f2555a", dash: "5 3", width: 1.4 },
};

export function DiscoveryGraphPanel({
  graph,
  selectedAgentId,
}: {
  graph: DiscoveryGraph;
  selectedAgentId: string | null;
}) {
  const [scale, setScale] = useState(1);
  const [focused, setFocused] = useState<string | null>(null);

  const columns = useMemo(() => layerNodes(graph.nodes, graph.edges), [graph]);

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    columns.forEach((column, columnIndex) => {
      column.forEach((node, rowIndex) => {
        map.set(node.id, {
          x: PAD_X + columnIndex * (NODE_W + COL_GAP),
          y: PAD_Y + rowIndex * (NODE_H + ROW_GAP),
        });
      });
    });
    return map;
  }, [columns]);

  const width = PAD_X * 2 + Math.max(1, columns.length) * NODE_W + Math.max(0, columns.length - 1) * COL_GAP;
  const height =
    PAD_Y * 2 + Math.max(1, ...columns.map((column) => column.length)) * (NODE_H + ROW_GAP);

  const focusedNode = graph.nodes.find((node) => node.id === focused) ?? null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-lab-border px-3 py-2">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-lab-muted">
          <Waypoints className="size-3.5" /> discovery graph
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => setScale((s) => Math.max(0.55, s - 0.15))}>
            <Minus className="size-3" />
          </Button>
          <span className="w-9 text-center font-mono text-[10px] text-lab-muted">{Math.round(scale * 100)}%</span>
          <Button size="icon" variant="ghost" onClick={() => setScale((s) => Math.min(1.5, s + 0.15))}>
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-lab-border/70 px-3 py-1.5 font-mono text-[10px] text-lab-muted">
        <Badge tone="violet">{graph.stats.hypotheses} hypotheses</Badge>
        <Badge tone="cyan">{graph.stats.experiments} experiments</Badge>
        <Badge tone="emerald">{graph.stats.discoveries} discoveries</Badge>
        <Badge tone="error">{graph.stats.refuted} refuted</Badge>
        <span className="ml-auto flex items-center gap-1">
          <GitBranch className="size-3" /> {graph.edges.length} links
        </span>
      </div>

      {graph.nodes.length ? (
        <div className="max-h-[360px] overflow-auto bg-lab-void/40">
          <svg
            width={Math.max(width * scale, 320)}
            height={Math.max(height * scale, 150)}
            viewBox={`0 0 ${width} ${height}`}
            style={{ transformOrigin: "top left" }}
            role="img"
            aria-label="Discovery graph"
          >
            <defs>
              <marker id="arl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill="#465a72" />
              </marker>
              <marker id="arl-arrow-ok" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill="#35e0a1" />
              </marker>
              <marker id="arl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill="#f2555a" />
              </marker>
            </defs>

            {graph.edges.map((edge) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const style = EDGE_STYLE[edge.kind];
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x - 6;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const dimmed = Boolean(selectedAgentId) && graph.nodes.find((n) => n.id === edge.to)?.agentId !== selectedAgentId;

              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={style.width}
                  strokeDasharray={style.dash}
                  opacity={dimmed ? 0.18 : 0.75}
                  markerEnd={
                    edge.kind === "verified"
                      ? "url(#arl-arrow-ok)"
                      : edge.kind === "contradicted"
                        ? "url(#arl-arrow-bad)"
                        : "url(#arl-arrow)"
                  }
                />
              );
            })}

            {graph.nodes.map((node, index) => {
              const position = positions.get(node.id);
              if (!position) return null;
              const colors = STAGE_COLOR[node.stage];
              const dimmed = Boolean(selectedAgentId) && node.agentId !== selectedAgentId;

              return (
                <motion.g
                  key={node.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: dimmed ? 0.32 : 1, scale: 1 }}
                  transition={{ duration: 0.25, delay: Math.min(index * 0.006, 0.3) }}
                  style={{ transformOrigin: `${position.x}px ${position.y}px`, cursor: "pointer" }}
                  onClick={() => setFocused(focused === node.id ? null : node.id)}
                >
                  <rect
                    x={position.x}
                    y={position.y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={7}
                    fill={colors.fill}
                    stroke={focused === node.id ? "#35e0a1" : colors.stroke}
                    strokeWidth={focused === node.id ? 1.8 : 1}
                  />
                  <text
                    x={position.x + 9}
                    y={position.y + 18}
                    fill={colors.text}
                    className="font-mono"
                    style={{ fontSize: 9.5, letterSpacing: "0.06em" }}
                  >
                    {STAGE_META[node.stage].label.toUpperCase()}
                    {node.confidence !== null ? ` · ${percent(node.confidence)}` : ""}
                  </text>
                  <text x={position.x + 9} y={position.y + 33} fill="#dbe6f2" style={{ fontSize: 10.5 }}>
                    {node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label}
                  </text>
                  <text
                    x={position.x + NODE_W - 9}
                    y={position.y + 18}
                    textAnchor="end"
                    fill="#7d8ea3"
                    className="font-mono"
                    style={{ fontSize: 8.5 }}
                  >
                    {node.agentName.length > 12 ? `${node.agentName.slice(0, 11)}…` : node.agentName}
                  </text>
                </motion.g>
              );
            })}
          </svg>
        </div>
      ) : (
        <div className="flex min-h-[150px] items-center justify-center px-4 text-center font-mono text-[11px] text-lab-muted">
          The graph fills in as hypotheses, experiments and discoveries get published.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-lab-border px-3 py-1.5 font-mono text-[10px] text-lab-muted">
        {(["hypothesis", "experiment", "discovery", "next"] as DiscoveryNodeStage[]).map((stage) => (
          <span key={stage} className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: STAGE_COLOR[stage].stroke }} />
            {STAGE_META[stage].label}
          </span>
        ))}
        <span className="ml-auto">solid = builds on · dashed = read as context · green = verified</span>
      </div>

      {focusedNode ? (
        <div className={cn("border-t border-lab-border bg-lab-void/40 px-4 py-3")}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STAGE_META[focusedNode.stage].tone}>{focusedNode.stage}</Badge>
            <span className="font-mono text-[11px] text-lab-text">{focusedNode.agentName}</span>
            <span className="font-mono text-[10px] text-lab-muted">cycle {focusedNode.iteration}</span>
            <span className="font-mono text-[10px] text-lab-muted">{formatClock(focusedNode.createdAt)}</span>
            {focusedNode.confidence !== null ? (
              <Badge tone="active">confidence {percent(focusedNode.confidence)}</Badge>
            ) : null}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFocused(null)}>
              close
            </Button>
          </div>
          <h3 className="mt-2 text-sm font-medium text-lab-text">{focusedNode.entry.title}</h3>
          <Markdown content={focusedNode.entry.content} className="mt-1 text-lab-text/90" />
          {focusedNode.entry.code ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded border border-lab-border bg-lab-void/70 p-2 font-mono text-[11px] text-[#c8d8ea]">
              <code>{focusedNode.entry.code}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
