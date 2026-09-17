// Timer-ownership selftest (AC12).
//
// The plugin must not leave work behind when its fiber is disposed: an
// unloaded/reloaded plugin that still holds a live timer keeps writing to the
// store. This drives the real apply() with a fake ctx that records disposers,
// then asserts that running them clears every timer apply() created.
import assert from "node:assert";
import "./test-isolation.mjs"; // MUST precede lib/index.js: pins DSH_HOME to a temp dir
import { apply } from "./lib/index.js";

const created = new Map();
const cleared = [];
let nextId = 1;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const disposers = [];
const ctx = {
  logger: { warn() {} },
  get: () => undefined,
  connection: { requestRejection: () => undefined },
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); return () => d && d(); },
  on: () => () => {},
  webServer: { register: () => () => {} },
};

// The stubs must stay installed through BOTH the apply() call and the dispose
// step, or the disposer would call the real clearTimeout with a stub id.
globalThis.setTimeout = (fn, ms) => { const id = nextId++; created.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = (id) => { cleared.push(id); created.delete(id); };

let scheduled;
try {
  apply(ctx);
  scheduled = [...created.values()];
  console.log("timers created by apply():", scheduled.length, scheduled.map((s) => s.ms + "ms").join(", "));
  assert.ok(scheduled.length > 0, "apply() schedules the debounced save and/or the backfill pass");

  // Disposing every effect the plugin registered must clear every timer it created.
  for (const d of disposers) d();
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

const leaked = [...created.keys()];
console.log("timers still live after dispose:", leaked.length, "| cleared:", cleared.length);
assert.strictEqual(leaked.length, 0, "every timer apply() created must be cleared by its fiber disposer");
console.log("ALL PASS");
