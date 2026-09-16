// Verify the one-time daily migration: sessions already marked in `backfilled`
// fold into daily ONLY (totals untouched), dailyDone flips after the pass.
// Requires real session logs; the root comes from the environment
// ($DSH_HOME/sessions or ~/.dsh/sessions), never a hardcoded path.
import { backfillOnce, dayKeyOf } from "./lib/index.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const root = path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "sessions");

// Simulate the pre-migration store: every existing session already marked,
// daily empty, totals already known (kept non-zero to assert no re-inflation).
let projects;
try {
  projects = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch {
  console.log("SKIPPED (no session logs under " + root + ")");
  process.exit(0);
}
const allIds = [];
for (const p of projects) {
  for (const sd of readdirSync(path.join(root, p.name), { withFileTypes: true })) {
    if (sd.isDirectory() && sd.name.startsWith("session-")) allIds.push(sd.name.slice("session-".length));
  }
}
if (allIds.length === 0) {
  console.log("SKIPPED (no sessions under " + root + ")");
  process.exit(0);
}
const store = { totals: { ...ZERO, uncachedInputTokens: 777 }, daily: {}, backfilled: new Set(allIds), epoch: 0, dailyDone: false };

const added = backfillOnce(store, root);
console.log("sessions migrated:", added, "| dailyDone:", store.dailyDone);
console.log("totals unchanged:", JSON.stringify(store.totals));
console.log("daily days:", Object.keys(store.daily).length);
const days = Object.keys(store.daily).sort();
if (days.length === 0) throw new Error("FAIL daily empty after migration");
if (store.totals.uncachedInputTokens !== 777) throw new Error("FAIL totals re-inflated");
if (store.dailyDone !== true) throw new Error("FAIL dailyDone not set");

// spot check: print the latest 5 days with their cache-hit rates
for (const k of days.slice(-5)) {
  const b = store.daily[k];
  const hit = b.cacheReadTokens / (b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens);
  console.log(k, "total:", (b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens).toLocaleString(), "hit:", (hit * 100).toFixed(1) + "%");
}
console.log("ALL PASS");
