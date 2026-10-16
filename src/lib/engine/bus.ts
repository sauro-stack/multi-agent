import "server-only";

import type { StreamEvent, StreamEventType } from "@/lib/types";

/**
 * In-process fan-out for SSE.
 *
 * The scheduler, the HTTP routes and every open stream live in the same Node
 * process, so a plain map of listeners is enough — and it keeps the local dev
 * experience free of external infrastructure. Swapping this for Redis pub/sub
 * only requires replacing `publish`/`subscribe` (see README: Scaling out).
 */

type Listener = (event: StreamEvent) => void;

interface BusState {
  listeners: Map<string, Set<Listener>>;
  sequence: number;
}

const globalRef = globalThis as unknown as { __arlBus?: BusState };

function state(): BusState {
  if (!globalRef.__arlBus) {
    globalRef.__arlBus = { listeners: new Map(), sequence: 0 };
  }
  return globalRef.__arlBus;
}

export function publish(roomId: string, event: StreamEvent): void {
  const bus = state();
  const set = bus.listeners.get(roomId);
  if (!set?.size) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // A broken stream must never take down the agent loop.
      set.delete(listener);
    }
  }
}

export function subscribe(roomId: string, listener: Listener): () => void {
  const bus = state();
  let set = bus.listeners.get(roomId);
  if (!set) {
    set = new Set();
    bus.listeners.set(roomId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) bus.listeners.delete(roomId);
  };
}

export function subscriberCount(roomId: string): number {
  return state().listeners.get(roomId)?.size ?? 0;
}

export function totalSubscribers(): number {
  let total = 0;
  for (const set of state().listeners.values()) total += set.size;
  return total;
}

/** Convenience for logging which event types flow through the bus. */
export function publishTyped<T extends StreamEventType>(roomId: string, type: T, event: StreamEvent): void {
  publish(roomId, { ...event, type } as StreamEvent);
}
