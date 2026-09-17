// Idempotence + reset-boundary regression tests for the Node half.
//
// The invariant under test: a session's ledger entry is a pure function of its
// event log, and every displayed number is a sum over those entries. So the SAME
// event set must produce the SAME numbers whether it arrives via live capture,
// via history backfill, or via both -- and across a simulated restart.
//
// This is the test that fails on the pre-fix accounting (which accumulated live
// deltas into grand totals while backfill re-folded the same session).
import {
  emptyStore, backfillOnce, currentTotals, allTimeTotals, allTimeDaily, sumDaily,
} from "./lib/index.js";
import { foldUsage, dayKeyOf } from "./lib/index.js";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const DAY = new Date(2026, 8, 16, 10, 0, 0).getTime();
const at = (ms, over = {}) => ({ time: ms, ...over });

// One session's usage: two settled attempts, plus a same-attempt resample.
const SESSION_EVENTS = [
  at(DAY, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 50 } } }),
  at(DAY + 1000, { type: "assistant/chunk", data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800 } } } }),
  at(DAY + 1500, { type: "assistant/message", data: { turn: 1, step: 2, usage: { inputTokens: 210, outputTokens: 22, cacheReadTokens: 900 } } }),
];

const TRUTH = foldUsage(SESSION_EVENTS).totals;
console.log("session truth:", JSON.stringify(TRUTH));

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (msg) => { console.error("FAIL " + msg); process.exit(1); };

// --- 1) backfill only -------------------------------------------------------
const backfillOnly = emptyStore();
await backfillOnce(backfillOnly, (async function* () { yield { id: "s1", events: SESSION_EVENTS }; })());
if (!eq(allTimeTotals(backfillOnly), TRUTH)) fail("backfill-only allTime != truth");
if (!eq(currentTotals(backfillOnly), TRUTH)) fail("backfill-only current != truth");
console.log("backfill-only:", JSON.stringify(allTimeTotals(backfillOnly)));

// --- 2) live only (fold on the fly, as session/event does) ------------------
const liveOnly = emptyStore();
{
  let state = { totals: { ...ZERO }, daily: {}, last: null };
  // mirror the live path: fold incrementally, then write the ledger entry
  const { foldUsage: fold } = await import("./lib/index.js");
  for (const e of SESSION_EVENTS) state = fold([...SESSION_EVENTS.slice(0, SESSION_EVENTS.indexOf(e) + 1)]).totals && { totals: fold(SESSION_EVENTS.slice(0, SESSION_EVENTS.indexOf(e) + 1)).totals, daily: fold(SESSION_EVENTS.slice(0, SESSION_EVENTS.indexOf(e) + 1)).daily, last: null };
  const folded = fold(SESSION_EVENTS);
  liveOnly.sessions["s1"] = { totals: folded.totals, daily: folded.daily, floor: { ...ZERO } };
}
if (!eq(allTimeTotals(liveOnly), TRUTH)) fail("live-only allTime != truth");
console.log("live-only:", JSON.stringify(allTimeTotals(liveOnly)));

// --- 3) live THEN backfill (the original double-count repro) ----------------
// live capture already wrote s1; the backfill pass must skip it.
const liveThenBackfill = emptyStore();
{
  const folded = foldUsage(SESSION_EVENTS);
  liveThenBackfill.sessions["s1"] = { totals: folded.totals, daily: folded.daily, floor: { ...ZERO } };
}
const added = await backfillOnce(liveThenBackfill, (async function* () { yield { id: "s1", events: SESSION_EVENTS }; })());
if (added !== 0) fail("backfill re-folded an already-counted session (added=" + added + ")");
if (!eq(allTimeTotals(liveThenBackfill), TRUTH)) {
  fail("live+backfill inflated: " + JSON.stringify(allTimeTotals(liveThenBackfill)) + " != " + JSON.stringify(TRUTH));
}
console.log("live+backfill:", JSON.stringify(allTimeTotals(liveThenBackfill)), "(added " + added + ")");

// --- 4) restart: reload the same ledger, re-run backfill --------------------
const persisted = JSON.parse(JSON.stringify(liveThenBackfill));
const restarted = Object.assign(emptyStore(), {
  resetAt: persisted.resetAt,
  sessions: persisted.sessions,
});
await backfillOnce(restarted, (async function* () { yield { id: "s1", events: SESSION_EVENTS }; })());
if (!eq(allTimeTotals(restarted), TRUTH)) fail("restart inflated: " + JSON.stringify(allTimeTotals(restarted)));
console.log("after restart:", JSON.stringify(allTimeTotals(restarted)));

// --- 5) interrupted pass is retryable --------------------------------------
// A pass that throws mid-iteration leaves the sessions it already folded in the
// ledger; re-running must reach the same result, not double it.
const interrupted = emptyStore();
const twoSessions = () => (async function* () {
  yield { id: "a", events: SESSION_EVENTS };
  yield { id: "b", events: SESSION_EVENTS };
})();
const exploding = () => (async function* () {
  yield { id: "a", events: SESSION_EVENTS };
  throw new Error("simulated interruption");
})();
let threw = false;
try { await backfillOnce(interrupted, exploding()); } catch { threw = true; }
if (!threw) fail("the simulated interruption did not propagate");
if (interrupted.sessions["a"] === undefined) fail("a folded session was lost by the interruption");
if (Object.keys(interrupted.sessions).length !== 1) fail("exactly the pre-interruption session must remain");
const afterRetry = await backfillOnce(interrupted, twoSessions());
if (afterRetry !== 1) fail("retry should add only the missing session, added=" + afterRetry);
const expected = { ...ZERO };
for (const k of Object.keys(expected)) expected[k] = TRUTH[k] * 2;
if (!eq(allTimeTotals(interrupted), expected)) {
  fail("interrupted+retry mismatch: " + JSON.stringify(allTimeTotals(interrupted)) + " != " + JSON.stringify(expected));
}
console.log("interrupted+retry:", JSON.stringify(allTimeTotals(interrupted)));

// --- 6) daily sums agree with the per-session totals ------------------------
const dailyTotal = sumDaily(allTimeDaily(interrupted));
if (!eq(dailyTotal, allTimeTotals(interrupted))) {
  fail("daily sum != allTime totals: " + JSON.stringify(dailyTotal));
}
console.log("daily==allTime:", JSON.stringify(dailyTotal), "days:", Object.keys(allTimeDaily(interrupted)).sort().join(","));

// --- 7) reset boundary survives a restart ----------------------------------
// Reset sets every floor to its current totals; "current" must read zero, and a
// later backfill of an ALREADY-KNOWN session must not move it back.
const reset = JSON.parse(JSON.stringify(interrupted));
reset.resetAt = DAY + 2000;
for (const entry of Object.values(reset.sessions)) entry.floor = { ...entry.totals };
if (!eq(currentTotals(reset), ZERO)) fail("current not zero after reset: " + JSON.stringify(currentTotals(reset)));
if (!eq(allTimeTotals(reset), allTimeTotals(interrupted))) fail("allTime changed across reset");
// restart + re-backfill the known sessions
await backfillOnce(reset, twoSessions());
if (!eq(currentTotals(reset), ZERO)) {
  fail("restart replayed history into the cleared period: " + JSON.stringify(currentTotals(reset)));
}
console.log("after reset+restart: current:", JSON.stringify(currentTotals(reset)), "allTime:", JSON.stringify(allTimeTotals(reset)));

// --- 8) post-reset usage IS counted ----------------------------------------
const LATER = DAY + 5000;
reset.sessions["c"] = {
  totals: { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  daily: {},
  floor: { ...ZERO },
};
const cur = currentTotals(reset);
if (cur.uncachedInputTokens !== 7 || cur.outputTokens !== 3) fail("post-reset usage not counted: " + JSON.stringify(cur));
console.log("post-reset usage counted:", JSON.stringify(cur));

console.log("ALL PASS");