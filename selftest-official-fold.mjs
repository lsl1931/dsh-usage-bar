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
let attemptOnlyNonZero = 0;
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
  // How much teeth the corpus gives the assistant/attempt branch: an attempt
  // whose stream reports real usage and that never settles a message.
  const settled = new Set(
    events.filter((e) => e.type === "assistant/message").map((e) => e.data?.turn + ":" + e.data?.step),
  );
  for (const event of events) {
    if (event.type !== "assistant/attempt") continue;
    if (settled.has(event.data?.turn + ":" + event.data?.step)) continue;
    const sample = lastAssistantStreamChunk(event.data?.stream, "usage")?.usage;
    if (sample !== undefined && (sample.inputTokens ?? 0) + (sample.outputTokens ?? 0) > 0) attemptOnlyNonZero += 1;
  }
}

// --- synthetic guards -------------------------------------------------------
// The real corpus can be blind here: on this machine every attempt that never
// settles a message reports ZERO tokens, so the parity walk above would still
// pass with the assistant/attempt branch deleted. These sequences go through
// BOTH folds, and their expected totals are non-zero, so dropping the branch
// fails this file.
const attemptEvent = (turn, step, usage) => ({
  type: "assistant/attempt",
  data: { turn, step, stream: [{ type: "chunk", chunk: { type: "usage", usage } }] },
});
const synthetic = [
  {
    name: "attempt only (never settles a message)",
    events: [attemptEvent(3, 1, { inputTokens: 30, outputTokens: 3 })],
    expected: { uncachedInputTokens: 30, outputTokens: 3 },
  },
  {
    name: "attempt replaced by its settling message",
    events: [
      attemptEvent(3, 2, { inputTokens: 30, outputTokens: 3 }),
      { type: "assistant/message", data: { turn: 3, step: 2, usage: { inputTokens: 31, outputTokens: 4 } } },
    ],
    expected: { uncachedInputTokens: 31, outputTokens: 4 },
  },
  {
    name: "attempt + retry-started + attempt adds",
    events: [
      attemptEvent(4, 1, { inputTokens: 10, outputTokens: 1 }),
      { type: "llm/retry-started", data: { turn: 4, step: 1 } },
      attemptEvent(4, 1, { inputTokens: 12, outputTokens: 2 }),
    ],
    expected: { uncachedInputTokens: 22, outputTokens: 3 },
  },
];
for (const scenario of synthetic) {
  const official = officialTokenUsage(scenario.events);
  const ours = foldUsage(scenario.events).totals;
  assert.ok(
    bucketsEqual(official, ours),
    "synthetic parity[" + scenario.name + "] official=" + JSON.stringify(official) + " plugin=" + JSON.stringify(ours),
  );
  assert.deepStrictEqual(
    { uncachedInputTokens: ours.uncachedInputTokens, outputTokens: ours.outputTokens },
    scenario.expected,
    "synthetic total[" + scenario.name + "]",
  );
}
if (attemptOnlyNonZero === 0) {
  console.log("NOTE: no real session has a non-zero attempt-only sample; the synthetic cases guard that branch");
}

for (const difference of differences.slice(0, 5)) {
  console.error("DIFF " + difference.file.slice(-48));
  console.error("  official:", JSON.stringify(difference.official));
  console.error("  plugin  :", JSON.stringify(difference.ours));
}
assert.ok(compared > 0, "found " + files.length + " log(s) but decoded none");
assert.strictEqual(differences.length, 0, "plugin fold must equal the harness tokenUsage fold on every session");
console.log("ALL PASS", JSON.stringify({ compared }));
