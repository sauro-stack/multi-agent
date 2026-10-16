"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildDiscoveryGraph } from "@/lib/discovery";
import type { Agent, DiscoveryGraph, LogEntry, ResearchRoom, StreamEvent } from "@/lib/types";

/**
 * Subscribes to `GET /api/rooms/:id/stream` (SSE) and folds every event into a
 * single client-side snapshot. `EventSource` handles reconnection natively and
 * replays from `Last-Event-ID`, so a blip never loses entries.
 */

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

export interface LabNotification {
  id: string;
  message: string;
  tone: "warn" | "error" | "info";
  at: number;
}

export interface RoomStreamSnapshot {
  room: ResearchRoom;
  agents: Agent[];
  entries: LogEntry[];
  graph: DiscoveryGraph;
  connection: ConnectionState;
  events: number;
  lastEventAt: number | null;
  error: string | null;
}

const MAX_ENTRIES = 500;

function upsertAgent(agents: Agent[], next: Agent): Agent[] {
  const index = agents.findIndex((agent) => agent.id === next.id);
  if (index === -1) return [...agents, next];
  const copy = [...agents];
  copy[index] = next;
  return copy;
}

function appendEntries(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const seen = new Set(current.map((entry) => entry.seq));
  const fresh = incoming.filter((entry) => !seen.has(entry.seq));
  if (!fresh.length) return current;
  const merged = [...current, ...fresh].sort((a, b) => a.seq - b.seq);
  return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
}

export function useRoomStream(initial: {
  room: ResearchRoom;
  agents: Agent[];
  entries: LogEntry[];
}) {
  const [room, setRoom] = useState<ResearchRoom>(initial.room);
  const [agents, setAgents] = useState<Agent[]>(initial.agents);
  const [entries, setEntries] = useState<LogEntry[]>(initial.entries);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [events, setEvents] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<LabNotification[]>([]);

  const sourceRef = useRef<EventSource | null>(null);
  const [generation, setGeneration] = useState(0);

  const pushNotification = useCallback((notification: LabNotification) => {
    setNotifications((current) => [notification, ...current].slice(0, 4));
    setTimeout(() => {
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    }, 9000);
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/rooms/${initial.room.id}/stream`);
    sourceRef.current = source;

    source.onopen = () => {
      setConnection("live");
      setError(null);
    };

    source.onerror = () => {
      // EventSource retries on its own; surface the state, don't tear down.
      setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };

    source.onmessage = (message) => {
      let event: StreamEvent;
      try {
        event = JSON.parse(message.data) as StreamEvent;
      } catch {
        return;
      }

      setEvents((count) => count + 1);
      setLastEventAt(Date.now());

      switch (event.type) {
        case "hello": {
          setRoom(event.room);
          setAgents(event.agents);
          setConnection("live");
          break;
        }
        case "log_entry": {
          setEntries((current) => appendEntries(current, [event.entry]));
          break;
        }
        case "agent_updated": {
          setAgents((current) => upsertAgent(current, event.agent));
          break;
        }
        case "room_updated": {
          setRoom(event.room);
          break;
        }
        case "rate_limit": {
          setAgents((current) => upsertAgent(current, event.agent));
          pushNotification({
            id: `${event.agent.id}-${Date.now()}`,
            message: event.message,
            tone: "warn",
            at: Date.now(),
          });
          break;
        }
        case "error": {
          setError(event.message);
          pushNotification({
            id: `err-${Date.now()}`,
            message: event.message,
            tone: "error",
            at: Date.now(),
          });
          break;
        }
        case "heartbeat": {
          break;
        }
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [initial.room.id, generation, pushNotification]);

  const graph = useMemo(() => buildDiscoveryGraph(entries, 64), [entries]);

  const reconnect = useCallback(() => {
    sourceRef.current?.close();
    setConnection("connecting");
    setGeneration((value) => value + 1);
  }, []);

  return {
    room,
    agents,
    entries,
    graph,
    connection,
    events,
    lastEventAt,
    error,
    notifications,
    reconnect,
    dismissNotification: (id: string) =>
      setNotifications((current) => current.filter((item) => item.id !== id)),
  };
}

/** Re-renders every `intervalMs` so countdowns stay honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Imperative fetchers used by the dashboard controls. */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data;
}

export async function patchJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data;
}
