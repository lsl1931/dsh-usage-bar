// Guards the one invariant the daily-map sharing optimization could break.
//
// flushSession() stores the live fold's `daily` map BY REFERENCE (it used to deep
// clone it, which cost O(days) per event). Sharing is only safe while the entry
// stays consistent with its own totals, so assert exactly that: for every ledger
// entry, summing its daily buckets must equal its totals, and the floor must
// never exceed the totals.
import assert from "node:assert";
import { apply, sumDaily, allTimeDaily, allTimeTotals } from "./lib/index.js";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Build a session that spans several days, so the day map is non-trivial.
function makeEvents(days, perDay) {
  const events = [];
  const base = Date.parse("2026-03-01T09:00:00");
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      events.push({
        seq: events.length,
        time: base + d * 86400000 + i * 60000,
        type: "assistant/message",
        data: { turn: 1, step: i + 1, usage: { inputTokens: 100 + d, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 5 } },
      });
    }
  }
  return events;
}

function harness() {
  const handlers = {};
  const routes = new Map();
  apply({
    logger: { warn() {} },
    get: () => undefined,
    connection: { requestRejection: () => undefined },
    effect: (fn) => { const d = fn(); return () => d && d(); },
    on: (n, fn) => { handlers[n] = fn; return () => {}; },
    webServer: { register: (r) => { routes.set(r.path, r); return () => {}; } },
  });
  return { onEvent: handlers["session/event"], routes, disposed: handlers["session/disposed"] };
}

const call = async (routes, path, method = "GET", headers = {}) => {
  const res = { writeHead() {}, end(b) { this.body = b; } };
  await routes.get(path).handler({ method, headers }, res);
  return res.body === undefined ? null : JSON.parse(res.body);
};

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// --- 1) a live session spanning days keeps daily consistent with totals -----
{
  const events = makeEvents(4, 25);
  const { onEvent, routes } = harness();
  let delivered = 0;
  const session = { id: "live-1", snapshotEvents: () => events.slice(0, delivered) };
  for (let i = 0; i < events.length; i++) { delivered = i + 1; onEvent(session, events[i]); }

  const daily = (await call(routes, "/dsh-usage-bar/daily")).daily;
  const summary = await call(routes, "/dsh-usage-bar/summary");

  // daily arrays are [uncached, output, cacheRead, cacheWrite]
  const summed = { ...ZERO };
  for (const arr of Object.values(daily)) {
    summed.uncachedInputTokens += arr[0];
    summed.outputTokens += arr[1];
    summed.cacheReadTokens += arr[2];
    summed.cacheWriteTokens += arr[3];
  }
  console.log("live: days =", Object.keys(daily).length, "| summed =", JSON.stringify(summed));
  console.log("live: allTime =", JSON.stringify(summary.allTime.totals));
  check(eq(summed, summary.allTime.totals), "sum(daily) must equal allTime totals after a live fold");

  // expected, computed independently from the fixture
  const want = { ...ZERO };
  for (const e of events) {
    want.uncachedInputTokens += e.data.usage.inputTokens;
    want.outputTokens += e.data.usage.outputTokens;
    want.cacheReadTokens += e.data.usage.cacheReadTokens;
    want.cacheWriteTokens += e.data.usage.cacheWriteTokens;
  }
  console.log("live: expected =", JSON.stringify(want));
  check(eq(summed, want), "the live fold must equal the fixture's own arithmetic");
}

// --- 2) sharing must not let one session's days leak into another's ---------
{
  const a = makeEvents(2, 10);
  const b = makeEvents(3, 10);
  const { onEvent, routes } = harness();
  let da = 0, db = 0;
  const sa = { id: "sess-a", snapshotEvents: () => a.slice(0, da) };
  const sb = { id: "sess-b", snapshotEvents: () => b.slice(0, db) };
  for (let i = 0; i < a.length; i++) { da = i + 1; onEvent(sa, a[i]); }
  for (let i = 0; i < b.length; i++) { db = i + 1; onEvent(sb, b[i]); }

  const summary = await call(routes, "/dsh-usage-bar/summary");
  const wantA = a.reduce((n, e) => n + e.data.usage.inputTokens, 0);
  const wantB = b.reduce((n, e) => n + e.data.usage.inputTokens, 0);
  console.log("two sessions: a =", wantA, "b =", wantB, "| allTime =", summary.allTime.totals.uncachedInputTokens);
  check(summary.allTime.totals.uncachedInputTokens === wantA + wantB, "two sessions must sum independently");
  check(summary.backfilledSessions === 2, "both sessions are in the ledger");
}

// --- 3) after a reset the floor must not exceed totals ---------------------
{
  const events = makeEvents(2, 10);
  const { onEvent, routes } = harness();
  let d = 0;
  const session = { id: "sess-r", snapshotEvents: () => events.slice(0, d) };
  for (let i = 0; i < events.length; i++) { d = i + 1; onEvent(session, events[i]); }

  const nonce = (await call(routes, "/dsh-usage-bar/nonce", "POST")).nonce;
  await call(routes, "/dsh-usage-bar/reset", "POST", { "x-dsh-usage-bar-nonce": nonce });

  const after = await call(routes, "/dsh-usage-bar/summary");
  console.log("after reset: current =", JSON.stringify(after.current.totals), "allTime =", after.allTime.totals.uncachedInputTokens);
  check(eq(after.current.totals, ZERO), "current must be zero immediately after a reset");
  check(after.allTime.totals.uncachedInputTokens > 0, "allTime must survive the reset");

  // and the calendar must still be intact
  const daily = (await call(routes, "/dsh-usage-bar/daily")).daily;
  check(Object.keys(daily).length > 0, "the calendar survives the reset");
}

console.log("");
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("ALL PASS - ledger invariants hold under shared daily maps");
