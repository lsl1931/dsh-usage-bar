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

// 4) assistant/attempt: an early sample shares its attempt's replacement slot
//    (the settling message replaces it), and stands on its own when the attempt
//    never settles a message - exactly the official fold's semantics.
const attempt = (turn, step, usage) => ({
  type: "assistant/attempt",
  data: { turn, step, stream: [{ type: "chunk", chunk: { type: "usage", usage } }] },
});
t = foldUsage([
  attempt(1, 1, { inputTokens: 120, outputTokens: 20 }),
  { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 120, outputTokens: 20 } } },
]).totals;
console.log("attempt+message:", JSON.stringify(t));
if (t.uncachedInputTokens !== 120 || t.outputTokens !== 20) { console.error("FAIL attempt replacement"); process.exit(1); }
t = foldUsage([attempt(2, 1, { inputTokens: 30, outputTokens: 3 })]).totals;
console.log("attempt-only:", JSON.stringify(t));
if (t.uncachedInputTokens !== 30 || t.outputTokens !== 3) { console.error("FAIL attempt-only"); process.exit(1); }

// 5) Real log decode + fold, when this machine has DSH session logs.
// Paths come from the environment, never hardcoded: $DSH_HOME/sessions, or
// ~/.dsh/sessions. v4 renamed the artifact to session.v4.jsonl.zstd, and a
// session directory is not always named after its id, so discovery matches the
// version suffix and takes the highest generation. Skipped (not failed) when
// the machine has no logs at all, but a machine that HAS logs and decodes none
// fails: a silently empty section is how this test rotted last time.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_ARTIFACT = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/;

/** Highest-generation log artifact in one session directory, if any. */
function logOf(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const generations = [];
  for (const name of names) {
    const match = LOG_ARTIFACT.exec(name);
    if (match !== null) generations.push({ name, version: match[1] === undefined ? 0 : Number(match[1]) });
  }
  if (generations.length === 0) return undefined;
  generations.sort((a, b) => b.version - a.version);
  return join(dir, generations[0].name);
}

const sessionsRoot = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
let grand = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
let projects = [];
try {
  projects = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
} catch {
  projects = [];
}
const sessions = [];
for (const p of projects) {
  const dir = join(sessionsRoot, p.name);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue; // unreadable project dir: skip
  }
  for (const s of entries) {
    const file = logOf(join(dir, s));
    if (file !== undefined) sessions.push(file);
  }
}
if (sessions.length === 0) {
  console.log("real-log section: SKIPPED (no session logs under " + sessionsRoot + ")");
} else {
  let folded = 0;
  for (const file of sessions.slice(0, 6)) {
    try {
      const events = decodeSessionLog(readFileSync(file));
      const { totals, daily } = foldUsage(events);
      folded += 1;
      console.log(file.slice(-40), "events:", events.length, "totals:", JSON.stringify(totals), "days:", Object.keys(daily).length);
      for (const k of Object.keys(grand)) grand[k] += totals[k];
    } catch (e) {
      console.log(file.slice(-40), "skip:", e.message.slice(0, 50));
    }
  }
  if (folded === 0) {
    console.error("FAIL: found " + sessions.length + " session log(s) but decoded none");
    process.exit(1);
  }
  console.log("GRAND:", JSON.stringify(grand));
}
console.log("ALL PASS");
