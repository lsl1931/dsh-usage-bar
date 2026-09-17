// Real-log coverage for history ingestion.
//
// Under the per-session ledger there is no separate "daily migration": a session
// entry always carries its totals and its per-day buckets together, so this test
// asserts the two properties that matter against REAL logs on this machine:
//   1. folding real session logs populates the calendar (daily buckets exist),
//   2. a second pass is a no-op (idempotent), and totals never re-inflate.
//
// Log discovery here is a TEST fixture loader, not production logic: production
// discovery is ctx.sessionPersistence, which owns generation selection and
// migration. The loader below mirrors the documented rule (highest
// session.v{N}.jsonl.zstd wins) so this test can read real data standalone.
//
// Skipped (not failed) when no logs are present, so the portable assertions in
// the other selftests remain the always-on part of the suite.
import { backfillOnce, allTimeTotals, allTimeDaily, sumDaily, decodeSessionLog } from "./lib/index.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "sessions");
if (!existsSync(root)) {
  console.log("SKIPPED (no session logs under " + root + ")");
  process.exit(0);
}

/** Highest-generation zstd artifact in one session directory, or undefined. */
function logPathOf(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const gens = names
    .map((n) => {
      const m = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/.exec(n);
      return m === null ? undefined : { name: n, version: m[1] === undefined ? 0 : Number(m[1]) };
    })
    .filter((g) => g !== undefined)
    .sort((a, b) => b.version - a.version);
  return gens.length === 0 ? undefined : path.join(dir, gens[0].name);
}

const sessions = [];
for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  for (const entry of readdirSync(path.join(root, project.name), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const file = logPathOf(path.join(root, project.name, entry.name));
    if (file === undefined) continue;
    sessions.push({ id: entry.name, file });
  }
}
if (sessions.length === 0) {
  console.log("SKIPPED (no readable session logs under " + root + ")");
  process.exit(0);
}

const fixtures = () => (async function* () {
  for (const s of sessions) yield { id: s.id, events: decodeSessionLog(readFileSync(s.file)) };
})();

const store = { version: 3, resetAt: 0, sessions: {} };
const first = await backfillOnce(store, fixtures());
const totalsAfterFirst = JSON.stringify(allTimeTotals(store));
const daysAfterFirst = Object.keys(allTimeDaily(store)).length;
console.log("sessions folded:", first, "| daily days:", daysAfterFirst, "| totals:", totalsAfterFirst);

if (first !== sessions.length) throw new Error("FAIL expected every discovered session to be folded");
if (daysAfterFirst === 0) throw new Error("FAIL daily empty after ingestion");
if (JSON.stringify(sumDaily(allTimeDaily(store))) !== totalsAfterFirst) {
  throw new Error("FAIL daily sum != allTime totals");
}

// second pass must be a no-op: this is the double-count regression, on real data
const second = await backfillOnce(store, fixtures());
console.log("second pass added:", second, "| totals:", JSON.stringify(allTimeTotals(store)));
if (second !== 0) throw new Error("FAIL second pass re-folded known sessions");
if (JSON.stringify(allTimeTotals(store)) !== totalsAfterFirst) throw new Error("FAIL totals moved on re-run");

// spot check the latest few days
const days = Object.keys(allTimeDaily(store)).sort();
for (const k of days.slice(-5)) {
  const b = allTimeDaily(store)[k];
  const hit = b.cacheReadTokens / (b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens);
  const total = b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens;
  console.log(k, "total:", total.toLocaleString(), "hit:", (hit * 100).toFixed(1) + "%");
}
console.log("ALL PASS");