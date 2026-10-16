import { NextResponse } from "next/server";

import { totalSubscribers } from "@/lib/engine/bus";
import { describeRuntime, ensureRuntime, runtimeStatus } from "@/lib/engine/runtime";
import { SELECTABLE_PROVIDERS, PROVIDERS } from "@/lib/providers/config";
import { labIsEmpty, DEMO_PRESETS } from "@/lib/lab/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  ensureRuntime();
  const status = runtimeStatus();

  return NextResponse.json(
    {
      ok: true,
      summary: describeRuntime(),
      runtime: status,
      streams: totalSubscribers(),
      empty: labIsEmpty(),
      presets: DEMO_PRESETS.map((p) => ({ slug: p.slug, topic: p.topic })),
      providers: SELECTABLE_PROVIDERS.map((id) => {
        const config = PROVIDERS[id];
        return {
          id,
          label: config.label,
          defaultModel: config.defaultModel,
          models: config.models,
          requiresKey: config.requiresKey,
          envVar: config.apiKeyEnvVar,
          envConfigured: Boolean(process.env[config.apiKeyEnvVar]),
          note: config.note,
        };
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
