import { NextResponse } from "next/server";

import { SELECTABLE_PROVIDERS, PROVIDERS } from "@/lib/providers/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      providers: SELECTABLE_PROVIDERS.map((id) => {
        const config = PROVIDERS[id];
        return {
          id,
          label: config.label,
          models: config.models,
          defaultModel: config.defaultModel,
          requiresKey: config.requiresKey,
          docsUrl: config.docsUrl,
          accent: config.accent,
          note: config.note,
          maxContextTokens: config.maxContextTokens,
          supportsJsonMode: config.supportsJsonMode,
          apiKeyEnvVar: config.apiKeyEnvVar,
          envConfigured: Boolean(process.env[config.apiKeyEnvVar]),
        };
      }),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
