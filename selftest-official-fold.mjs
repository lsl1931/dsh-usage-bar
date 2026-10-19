// Parity selftest: the plugin's fold against the harness's own tokenUsage fold.
//
// This is the check that catches a silent accounting drift after a DSH update.
// The reference implementation below is a transcription of
// @deepseek-ai/dsh-token-meter/lib/types/usage-projection.js (tokenUsageProjectionDefinition,
// verified against 0.2.1-rc.2): a finalized message's data.usage wins; otherwise
// the sample is the last usage chunk in the settlement stream
// (lastAssistantStreamChunk(stream, 'usage') from dsh-llm); an
// assistant/attempt and the message that settles it share one (turn, step)
// replacement slot, and llm/retry-started closes that slot.
//
// Reads the REAL session logs (read-only) through test-isolation's
// REAL_SESSIONS_DIR, decodes them with the plugin's own decoder, and requires
// the two folds to agree on all four buckets for every session. Skips when the
// machine has no logs; any difference is a failure.
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REAL_SESSIONS_DIR } from "./test-isolation.mjs"; // also pins DSH_HOME for any import below
import { decodeSessionLog, foldUsage } from "./lib/index.js";

const zeroBuckets = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const bucketsFrom = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});

const bucketsEqual = (left, right) =>
  left.uncachedInputTokens === right.uncachedInputTokens &&
  left.outputTokens === right.outputTokens &&
  left.cacheReadTokens === right.cacheReadTokens &&
  left.cacheWriteTokens === right.cacheWriteTokens;

const addReplacing = (totals, previous, next) => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
});

/** dsh-llm's lastAssistantStreamChunk(stream, 'usage') */
function lastAssistantStreamChunk(stream, type) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "chunk" && record.chunk?.type === type) return record.chunk;
  }
  return undefined;
}

/** tokenUsageProjectionDefinition's usageOf */
function officialUsageOf(event) {
  if (event.type === "assistant/message" && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
  return lastAssistantStreamChunk(event.data?.stream, "usage")?.usage;
}

/** tokenUsageProjectionDefinition's apply, over one ordered log. */
function officialTokenUsage(events) {
  let totals = zeroBuckets();
  let last = null;
  for (const event of events) {
    if (event.type === "llm/retry-started") {
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
      continue;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const sample = officialUsageOf(event);
    if (sample === undefined) continue;
    const { turn, step } = event.data;
    const buckets = bucketsFrom(sample);
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined;
    if (previous !== undefined && bucketsEqual(previous, buckets)) continue;
    totals = addReplacing(totals, previous, buckets);
    last = { turn, step, buckets };
  }
  return totals;
}

const LOG_ARTIFACT = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/;

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

const files = [];
let projects = [];
try {
  projects = readdirSync(REAL_SESSIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
} catch {
  projects = [];
}
for (const project of projects) {
  const dir = join(REAL_SESSIONS_DIR, project.name);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const file = logOf(join(dir, entry));
    if (file !== undefined) files.push(file);
  }
}

if (files.length === 0) {
  console.log("SKIPPED (no session logs under " + REAL_SESSIONS_DIR + ")");
  process.exit(0);
}

let compared = 0;
const differences = [];
for (const file of files) {
  let events;
  try {
    events = decodeSessionLog(readFileSync(file));
  } catch {
    continue; // undecodable artifact: not this test's subject
  }
  compared += 1;
  const official = officialTokenUsage(events);
  const ours = foldUsage(events).totals;
  if (!bucketsEqual(official, ours)) {
    differences.push({ file, official, ours });
  }
}

for (const difference of differences.slice(0, 5)) {
  console.error("DIFF " + difference.file.slice(-48));
  console.error("  official:", JSON.stringify(difference.official));
  console.error("  plugin  :", JSON.stringify(difference.ours));
}
assert.ok(compared > 0, "found " + files.length + " log(s) but decoded none");
assert.strictEqual(differences.length, 0, "plugin fold must equal the harness tokenUsage fold on every session");
console.log("ALL PASS", JSON.stringify({ compared }));
