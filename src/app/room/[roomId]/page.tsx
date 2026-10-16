import { notFound } from "next/navigation";

import { LabDashboard } from "@/components/lab/dashboard";
import { ensureRuntime } from "@/lib/engine/runtime";
import { getRoom, listAgents, listLogEntries } from "@/lib/lab/store";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  // First hit on a room also boots the scheduler if nothing has yet.
  ensureRuntime();

  const room = getRoom(roomId);
  if (!room) notFound();

  return (
    <LabDashboard
      initial={{
        room,
        agents: listAgents(roomId),
        entries: listLogEntries(roomId, { limit: 150 }),
      }}
    />
  );
}
