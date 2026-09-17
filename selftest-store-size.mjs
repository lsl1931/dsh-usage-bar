// Store size and shape: the v3 ledger must stay proportional to real usage.
// The old v2 shape kept an unbounded `backfilled` id array that was re-serialized
// in full on every save; the per-session ledger replaces it with entries that are
// only as large as the data they describe.
import { emptyStore } from "./lib/index.js";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// Simulate a year of use: 200 sessions, each with a handful of active days.
const store = emptyStore();
const base = Date.parse("2026-01-01T00:00:00");
for (let s = 0; s < 200; s++) {
  const daily = {};
  for (let d = 0; d < 5; d++) {
    const day = new Date(base + (s * 5 + d) * 86400000);
    const key = day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
    daily[key] = { uncachedInputTokens: 12000, outputTokens: 900, cacheReadTokens: 48000, cacheWriteTokens: 100 };
  }
  store.sessions["session-" + String(s).padStart(4, "0") + "-aaaa-bbbb-cccc-dddddddddddd"] = {
    totals: { uncachedInputTokens: 60000, outputTokens: 4500, cacheReadTokens: 240000, cacheWriteTokens: 500 },
    daily,
    floor: { ...ZERO },
  };
}

const json = JSON.stringify({ version: 3, resetAt: 0, sessions: store.sessions });
const bytes = Buffer.byteLength(json, "utf8");
console.log("200 sessions x 5 days ->", bytes.toLocaleString(), "bytes (" + (bytes / 1024).toFixed(1) + " KiB)");
console.log("per session:", Math.round(bytes / 200), "bytes");
console.log("per day-bucket:", Math.round(bytes / 1000), "bytes");

// The old shape's unbounded id array, for comparison
const oldIds = JSON.stringify(Object.keys(store.sessions));
console.log("old `backfilled` id array alone:", Buffer.byteLength(oldIds, "utf8").toLocaleString(), "bytes");

const perSession = bytes / 200;
if (perSession > 2000) { console.error("FAIL: " + Math.round(perSession) + " bytes/session is disproportionate"); process.exit(1); }
if (bytes > 400 * 1024) { console.error("FAIL: store exceeds 400 KiB for 200 sessions"); process.exit(1); }
console.log("");
console.log("ALL PASS - store size is proportional to real usage");
