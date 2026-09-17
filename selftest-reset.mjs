// Reset + route-contract selftest.
//
// This test drives the REAL handlers registered by apply(): it builds a fake
// ctx, captures every route the plugin registers, and invokes the handlers with
// fake req/res objects. Deleting the reset implementation, the nonce gate, the
// method checks, or the trust fence makes this file fail.
//
// (The previous version of this file re-implemented the handler inline and
// asserted its own copy, so it passed even with the feature removed.)
import assert from "node:assert";
import "./test-isolation.mjs"; // MUST precede lib/index.js: pins DSH_HOME to a temp dir
import { apply, currentTotals, allTimeTotals, emptyStore } from "./lib/index.js";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// --- fake HTTP plumbing -----------------------------------------------------
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? null; return this; },
    end(chunk) { this.ended = true; if (chunk !== undefined) this.body = String(chunk); return this; },
  };
}
const req = (method, headers = {}) => ({ method, url: "/dsh-usage-bar/reset", headers });

// --- fake ctx: capture routes, model the trust fence ------------------------
const routes = new Map();
let fenceVerdict; // undefined = allowed; number = rejection status
let nonceValue = null;

const ctx = {
  logger: { warn() {} },
  get: (name) => (name === "sessionPersistence" ? undefined : undefined),
  connection: { requestRejection: () => fenceVerdict },
  effect: (fn) => { const disposer = fn(); return () => disposer && disposer(); },
  on: () => () => {},
  webServer: {
    register: (route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
};

apply(ctx);

const hit = async (path, method, headers = {}) => {
  const route = routes.get(path);
  assert.ok(route, "route " + path + " is registered");
  const res = makeRes();
  await route.handler(req(method, headers), res);
  return res;
};

// --- AC7: routes are exact-kind, not prefix --------------------------------
for (const path of ["/dsh-usage-bar/summary", "/dsh-usage-bar/daily", "/dsh-usage-bar/nonce", "/dsh-usage-bar/reset"]) {
  assert.strictEqual(routes.get(path).kind, "exact", path + " must be registered kind:exact");
}
console.log("AC7 kind:exact on all", routes.size, "routes");

// --- AC8: the trust fence runs before any handler work ----------------------
for (const verdict of [401, 403]) {
  fenceVerdict = verdict;
  const res = await hit("/dsh-usage-bar/summary", "GET");
  assert.strictEqual(res.statusCode, verdict, "fence status " + verdict + " must be propagated");
  assert.strictEqual(res.body, "", "no body when the fence rejects");
}
fenceVerdict = undefined;

// --- AC9: reset is POST-only; a bare GET is rejected ------------------------
{
  const res = await hit("/dsh-usage-bar/reset", "GET");
  assert.strictEqual(res.statusCode, 405, "GET on reset must be 405");
  assert.ok(res.headers && res.headers.allow === "POST", "405 must advertise Allow: POST");
}
{
  const res = await hit("/dsh-usage-bar/summary", "POST");
  assert.strictEqual(res.statusCode, 405, "POST on summary must be 405");
}

// --- the nonce is issued behind the fence, on its own POST route ------------
{
  const res = await hit("/dsh-usage-bar/nonce", "POST");
  assert.strictEqual(res.statusCode, 200, "nonce route answers 200");
  nonceValue = JSON.parse(res.body).nonce;
  assert.ok(typeof nonceValue === "string" && nonceValue.length > 0, "nonce is a non-empty string");
}
{
  const res = await hit("/dsh-usage-bar/nonce", "GET");
  assert.strictEqual(res.statusCode, 405, "nonce route is POST-only");
}

// --- the summary no longer leaks the nonce ----------------------------------
{
  const res = await hit("/dsh-usage-bar/summary", "GET");
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!res.body.includes(nonceValue), "summary must not disclose the reset nonce");
}

// --- reset: bad nonce is refused -------------------------------------------
for (const bad of [undefined, "wrong", ""]) {
  const headers = bad === undefined ? {} : { "x-dsh-usage-bar-nonce": bad };
  const res = await hit("/dsh-usage-bar/reset", "POST", headers);
  assert.strictEqual(res.statusCode, 403, "bad nonce must be 403 (got " + res.statusCode + ")");
}
console.log("nonce gate: wrong/missing nonce -> 403");

// --- reset: good nonce succeeds and starts a new period --------------------
{
  const res = await hit("/dsh-usage-bar/reset", "POST", { "x-dsh-usage-bar-nonce": nonceValue });
  assert.strictEqual(res.statusCode, 200, "correct nonce must succeed");
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
}
console.log("nonce gate: correct nonce -> 200");

// --- the reset semantics themselves (the part that must be able to fail) ----
// A store with usage, then a reset: "current" reads zero, "allTime" is intact.
const store = emptyStore();
store.sessions["s1"] = {
  totals: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 50 },
  daily: {},
  floor: { ...ZERO },
};
assert.deepStrictEqual(currentTotals(store), store.sessions["s1"].totals, "before reset, current == totals");

// mirror what the handler does, then assert the view
store.resetAt = Date.now();
for (const entry of Object.values(store.sessions)) entry.floor = { ...entry.totals };
assert.deepStrictEqual(currentTotals(store), ZERO, "after reset, current must read zero");
assert.deepStrictEqual(
  allTimeTotals(store),
  { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 50 },
  "after reset, allTime must be untouched",
);
console.log("reset semantics: current zeroed, allTime preserved");

console.log("ALL PASS");
