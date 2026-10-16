import type { NextRequest } from "next/server";

import { subscribe } from "@/lib/engine/bus";
import { ensureRuntime } from "@/lib/engine/runtime";
import { fail } from "@/lib/lab/http";
import { getRoom, listAgents, listLogEntries } from "@/lib/lab/store";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A streaming response must never be cached or statically analysed.
export const fetchCache = "force-no-store";
export const revalidate = 0;

const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 300;

/**
 * `GET /api/rooms/:id/stream`
 *
 * Emits `hello` (with a replay of everything after the client's cursor, so a
 * reconnect never loses entries), then every subsequent room event, with a
 * heartbeat to keep intermediaries from closing an idle connection.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<Response> {
  ensureRuntime();
  const { roomId } = await context.params;

  const room = getRoom(roomId);
  if (!room) return fail("Room not found", 404);

  const url = new URL(request.url);
  const cursorHeader = request.headers.get("last-event-id");
  const since = Number(cursorHeader ?? url.searchParams.get("since") ?? 0) || 0;

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };

      const write = (event: StreamEvent, id?: number | string) => {
        if (closed) return;
        const frame = `${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
        }
      };

      const replay = listLogEntries(roomId, { sinceSeq: since, limit: REPLAY_LIMIT });
      const agents = listAgents(roomId);

      write(
        {
          type: "hello",
          roomId,
          cursor: replay.length ? replay[replay.length - 1].seq : since,
          agents,
          room,
        },
        replay.length ? replay[0].seq - 1 : since,
      );

      for (const entry of replay) write({ type: "log_entry", entry }, entry.seq);

      unsubscribe = subscribe(roomId, (event) => {
        const id = event.type === "log_entry" ? event.entry.seq : undefined;
        write(event, id);
      });

      heartbeat = setInterval(() => {
        write({ type: "heartbeat", at: new Date().toISOString() });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },

    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
