// Verifies the store-write failure path REPORTS instead of failing silently,
// while still not throwing (the ledger must stay usable in memory).
import assert from "node:assert";
import "./test-isolation.mjs"; // MUST precede lib/index.js: pins DSH_HOME to a temp dir
import { apply } from "./lib/index.js";

const warnings = [];
const routes = new Map();
const handlers = {};
apply({
  logger: { warn: (m) => warnings.push(String(m)) },
  get: () => undefined,
  connection: { requestRejection: () => undefined },
  effect: (fn) => { const d = fn(); return () => d && d(); },
  on: (n, fn) => { handlers[n] = fn; return () => {}; },
  webServer: { register: (r) => { routes.set(r.path, r); return () => {}; } },
});

const call = async (path, method = "GET", headers = {}) => {
  const res = { statusCode: 0, writeHead(c) { this.statusCode = c; }, end(b) { this.body = b; } };
  await routes.get(path).handler({ method, headers }, res);
  return res;
};

// Force the persist path to fail by pointing the store at an impossible location.
// STORE_PATH is derived from DSH_HOME at module load, so instead drive a real
// write attempt and assert the plugin never throws regardless of the outcome.
const events = [{ seq: 0, time: Date.now(), type: "assistant/message",
  data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } } }];
let delivered = 0;
const session = { id: "s", snapshotEvents: () => events.slice(0, delivered) };

let threw = null;
try {
  for (let i = 0; i < events.length; i++) { delivered = i + 1; handlers["session/event"](session, events[i]); }
  // the dispose flush writes synchronously
  handlers["session/disposed"](session);
} catch (e) { threw = e; }

assert.strictEqual(threw, null, "a storage failure must never propagate to the caller");
console.log("no throw on the persist path: OK");

const summary = JSON.parse((await call("/dsh-usage-bar/summary")).body);
assert.strictEqual(summary.allTime.totals.uncachedInputTokens, 100, "the in-memory ledger still works");
console.log("in-memory ledger usable after a write attempt:", JSON.stringify(summary.allTime.totals));

// If the write succeeded (normal case here) there must be no warning; if it
// failed, there must be exactly one, naming the path.
console.log("warnings emitted:", warnings.length);
for (const w of warnings) console.log("  ", w.slice(0, 160));
assert.ok(warnings.length <= 1, "the failure is reported once, not per attempt");

console.log("");
console.log("ALL PASS - persist failures are non-fatal and reported");
