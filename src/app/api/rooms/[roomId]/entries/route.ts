import { NextResponse, type NextRequest } from "next/server";

import { buildDiscoveryGraph } from "@/lib/discovery";
import { fail, json } from "@/lib/lab/http";
import { getRoom, listLogEntries } from "@/lib/lab/store";
import { GRAPH_KINDS, LOG_KINDS, type LogEntryKind } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const { roomId } = await context.params;
  if (!getRoom(roomId)) return fail("Room not found", 404);

  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1000);
  const kindsParam = url.searchParams.get("kinds");
  const kinds = kindsParam
    ? (kindsParam.split(",").filter((k) => (LOG_KINDS as readonly string[]).includes(k)) as LogEntryKind[])
    : undefined;

  const entries = listLogEntries(roomId, { sinceSeq: since, limit, kinds });
  const graphEntries = listLogEntries(roomId, { limit: 240, kinds: GRAPH_KINDS });

  return json({
    entries,
    cursor: entries.length ? entries[entries.length - 1].seq : since,
    graph: buildDiscoveryGraph(graphEntries),
  });
}
