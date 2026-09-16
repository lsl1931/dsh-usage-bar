// Verify the all-time sum helper: sumDaily(daily) equals the fold of the same
// events, and the cache-hit formula stays consistent on the summed buckets.
import { foldUsage, sumDaily, dayKeyOf } from "./lib/index.js";

const DAY1 = new Date(2026, 8, 1, 10, 0, 0).getTime();
const DAY2 = new Date(2026, 8, 2, 10, 0, 0).getTime();
const mk = (ms, over = {}) => ({ time: ms, ...over });

const events = [
  mk(DAY1, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 50 } } }),
  mk(DAY2, { type: "assistant/message", data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 0 } } }),
];
const { totals, daily } = foldUsage(events);
const all = sumDaily(daily);

console.log("fold totals:  ", JSON.stringify(totals));
console.log("sumDaily:     ", JSON.stringify(all));
for (const k of Object.keys(totals)) {
  if (totals[k] !== all[k]) throw new Error("FAIL sumDaily mismatch on " + k);
}

// day keys are the two local days
const keys = Object.keys(daily).sort();
console.log("days:", keys.join(","));
if (keys.length !== 2) throw new Error("FAIL expected two days");

// all-time cache hit = 1200 / (300 + 1200 + 50)
const hit = all.cacheReadTokens / (all.uncachedInputTokens + all.cacheReadTokens + all.cacheWriteTokens);
if (Math.abs(hit - 1200 / 1550) > 1e-9) throw new Error("FAIL all-time hit");
console.log("all-time hit:", (hit * 100).toFixed(1) + "%");

// empty daily sums to zeros
const zero = sumDaily({});
if (zero.uncachedInputTokens !== 0 || zero.outputTokens !== 0) throw new Error("FAIL empty sum");
console.log("ALL PASS");
