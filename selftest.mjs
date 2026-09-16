// Local verification of the Node half's pure folds without booting DSH.
import { foldUsage, decodeSessionLog } from "./lib/index.js";
import { readFileSync } from "node:fs";

// 1) Fold semantics: final message sample replaces earlier chunk sample.
const events = [
  { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } } },
  { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 } } },
];
let t = foldUsage(events).totals;
console.log("replace-same-attempt:", JSON.stringify(t));
if (t.uncachedInputTokens !== 120 || t.outputTokens !== 20) { console.error("FAIL replace"); process.exit(1); }

// 2) Retry: retry-started closes the slot so the next sample ADDS.
const events2 = [
  ...events,
  { type: "llm/retry-started", data: { turn: 1, step: 1 } },
  { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } } },
];
t = foldUsage(events2).totals;
console.log("after-retry:", JSON.stringify(t));
if (t.uncachedInputTokens !== 170 || t.outputTokens !== 25) { console.error("FAIL retry"); process.exit(1); }

// 3) Cache buckets flow through.
const events3 = [
  { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50, totalTokens: 530 } } },
];
t = foldUsage(events3).totals;
const hit = t.cacheReadTokens / (t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens);
console.log("cache-hit:", (hit * 100).toFixed(1) + "%");
if (Math.abs(hit - 400 / 550) > 1e-9) { console.error("FAIL cache"); process.exit(1); }

// 4) Real log decode + fold, when this machine has DSH session logs.
// Paths come from the environment, never hardcoded: $DSH_HOME/sessions, or
// ~/.dsh/sessions. Skipped (not failed) when there is nothing to read, so the
// pure-fold assertions above stay the portable part of this test.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sessionsRoot = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
let grand = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
let projects = [];
try {
  projects = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch {
  projects = [];
}
let sessions = [];
for (const p of projects) {
  const dir = join(sessionsRoot, p.name);
  try {
    for (const s of readdirSync(dir)) {
      if (s.startsWith("session-")) sessions.push(join(dir, s, "session.jsonl.zstd"));
    }
  } catch {
    // unreadable project dir: skip
  }
}
if (sessions.length === 0) {
  console.log("real-log section: SKIPPED (no session logs under " + sessionsRoot + ")");
} else {
  for (const file of sessions.slice(0, 6)) {
    try {
      const events = decodeSessionLog(readFileSync(file));
      const { totals, daily } = foldUsage(events);
      console.log(file.slice(-40), "events:", events.length, "totals:", JSON.stringify(totals), "days:", Object.keys(daily).length);
      for (const k of Object.keys(grand)) grand[k] += totals[k];
    } catch (e) {
      console.log(file.slice(-40), "skip:", e.message.slice(0, 50));
    }
  }
  console.log("GRAND:", JSON.stringify(grand));
}
console.log("ALL PASS");
