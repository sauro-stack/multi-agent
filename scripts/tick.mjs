#!/usr/bin/env node
/**
 * External scheduler driver.
 *
 * `LAB_RUNTIME=external` stops the in-process tick loop; point a cron at this
 * script (or at `POST /api/tick` directly) and the queue keeps draining.
 *
 *   node scripts/tick.mjs                # drain due jobs
 *   node scripts/tick.mjs --fan-out      # first enqueue a cycle per idle agent
 *   LAB_BASE_URL=https://lab.example node scripts/tick.mjs
 */

const base = process.env.LAB_BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:3000";
const fanOut = process.argv.includes("--fan-out");
const limit = Number(process.env.LAB_TICK_LIMIT ?? 12);

try {
  const response = await fetch(`${base}/api/tick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ await: true, fanOut, limit }),
  });

  const data = await response.json().catch(() => ({}));
  console.log(`[tick] ${response.status}`, JSON.stringify(data, null, 2));
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.error(`[tick] failed against ${base}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}
