// Verify every claim in usage-bar-contracts.md against the real module.
import * as m from "./lib/index.js";
import { readFileSync } from "node:fs";

const fail = [];
const ok = (c, msg) => { if (!c) fail.push(msg); };

// §2.3 signatures
const expected = ["apply","backfillOnce","dayKeyOf","decodeSessionLog","emptyStore","foldUsage","inject","persistedSessions","resolveHarnessHome","sumDaily","allTimeDaily","allTimeTotals","currentTotals"];
for (const n of expected) ok(n in m, "missing export: " + n);
ok(Array.isArray(m.inject) && m.inject.join(",") === "webServer,connection", "inject must be [webServer, connection]");

// §3.3 env contract
ok(m.resolveHarnessHome({ DSH_HOME: "X:/h" }) === "X:/h", "DSH_HOME must win");
ok(m.resolveHarnessHome({ DSH_HOME: "   " }).endsWith(".dsh"), "blank DSH_HOME counts as unset");
ok(m.resolveHarnessHome({}).endsWith(".dsh"), "falls back to ~/.dsh");

// §2.1 store shape
const s = m.emptyStore();
ok(s.version === 3, "emptyStore version must be 3");
ok(typeof s.resetAt === "number", "resetAt present");
ok(Object.keys(s.sessions).length === 0, "sessions starts empty");

// §2.2 route shapes + fence, via the real apply()
const routes = new Map(); const handlers = {};
m.apply({
  logger: { warn() {} },
  get: () => undefined,
  connection: { requestRejection: () => undefined },
  effect: (fn) => { const d = fn(); return () => d && d(); },
  on: (n, f) => { handlers[n] = f; return () => {}; },
  webServer: { register: (r) => { routes.set(r.path, r); return () => {}; } },
});
for (const p of ["/dsh-usage-bar/summary","/dsh-usage-bar/daily","/dsh-usage-bar/nonce","/dsh-usage-bar/reset"]) {
  ok(routes.has(p), "route missing: " + p);
  ok(routes.get(p).kind === "exact", p + " must be kind:exact");
}

const call = async (p, method = "GET", headers = {}) => {
  const res = { statusCode: 0, headers: null, writeHead(c, h) { this.statusCode = c; this.headers = h ?? null; }, end(b) { this.body = b; } };
  await routes.get(p).handler({ method, url: p, headers }, res);
  return res;
};
const r1 = await call("/dsh-usage-bar/summary");
ok(r1.statusCode === 200, "summary 200");
const body = JSON.parse(r1.body);
ok("current" in body && "allTime" in body && "backfilledSessions" in body && "resetAt" in body, "summary fields");
for (const k of ["totals","billedInputTokens","totalTokens"]) ok(k in body.current, "current." + k);
const t = body.allTime.totals;
ok(body.allTime.billedInputTokens === t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens, "billedInputTokens formula");
ok(body.allTime.totalTokens === body.allTime.billedInputTokens + t.outputTokens, "totalTokens formula");
ok(r1.headers && r1.headers["cache-control"] === "no-store", "cache-control no-store");

const r2 = await call("/dsh-usage-bar/daily");
ok(r2.statusCode === 200 && "daily" in JSON.parse(r2.body), "daily shape");
const r3 = await call("/dsh-usage-bar/nonce", "GET");
ok(r3.statusCode === 405 && r3.headers.allow === "POST", "nonce GET -> 405 + Allow");
const r4 = await call("/dsh-usage-bar/reset", "POST", {});
ok(r4.statusCode === 403, "reset without nonce -> 403");

// fence actually gates
const routes2 = new Map();
m.apply({
  logger: { warn() {} }, get: () => undefined,
  connection: { requestRejection: () => 401 },
  effect: (fn) => { const d = fn(); return () => d && d(); },
  on: () => () => {},
  webServer: { register: (r) => { routes2.set(r.path, r); return () => {}; } },
});
const res = { statusCode: 0, writeHead(c) { this.statusCode = c; }, end() {} };
await routes2.get("/dsh-usage-bar/summary").handler({ method: "GET", headers: {} }, res);
ok(res.statusCode === 401, "fence must reject with 401");

console.log(fail.length === 0 ? "ALL PASS - code-spec claims match the implementation" : "FAILURES:\n  " + fail.join("\n  "));
if (fail.length) process.exit(1);
