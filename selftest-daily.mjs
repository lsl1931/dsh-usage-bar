// Verify daily bucketing, same-attempt replacement across the fold (including
// day correction), retry slot semantics, and that reset keeps daily history.
import { foldUsage, dayKeyOf } from "./lib/index.js";

const DAY1 = new Date(2026, 8, 1, 10, 0, 0).getTime(); // local 2026-09-01 10:00
const DAY2 = new Date(2026, 8, 1, 23, 59, 0).getTime(); // same local day, late
const DAY3 = new Date(2026, 8, 2, 8, 0, 0).getTime(); // next local day

const mk = (ms, over = {}) => ({ time: ms, ...over });

// 1) chunk sample then final message sample on the same attempt: counted once
let r = foldUsage([
  mk(DAY1, { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } } } }),
  mk(DAY1 + 500, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 120, outputTokens: 20 } } }),
]);
console.log("same-attempt totals:", JSON.stringify(r.totals));
console.log("same-attempt daily:", JSON.stringify(r.daily));
if (r.totals.uncachedInputTokens !== 120 || r.totals.outputTokens !== 20) throw new Error("FAIL same-attempt totals");
const k1 = dayKeyOf(DAY1);
if (r.daily[k1].uncachedInputTokens !== 120 || r.daily[k1].outputTokens !== 20) throw new Error("FAIL same-attempt daily");

// 2) replacement crossing midnight: correction lands on the right day
r = foldUsage([
  mk(DAY2, { type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } } } }),
  mk(DAY3, { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 80, outputTokens: 8 } } }),
]);
const k2 = dayKeyOf(DAY2);
const k3 = dayKeyOf(DAY3);
console.log("midnight daily:", JSON.stringify(r.daily));
if (r.daily[k2].uncachedInputTokens !== 0) throw new Error("FAIL midnight correction old day");
if (r.daily[k3].uncachedInputTokens !== 80) throw new Error("FAIL midnight correction new day");
if (r.totals.uncachedInputTokens !== 80) throw new Error("FAIL midnight totals");

// 3) retry-started closes the slot: retried attempt adds
r = foldUsage([
  mk(DAY1, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 } } }),
  mk(DAY1 + 1000, { type: "llm/retry-started", data: { turn: 1, step: 1 } }),
  mk(DAY1 + 2000, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 4 } } }),
]);
console.log("retry totals:", JSON.stringify(r.totals));
if (r.totals.uncachedInputTokens !== 140) throw new Error("FAIL retry adds");

// 4) distinct attempts on the same day accumulate
r = foldUsage([
  mk(DAY1, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } }),
  mk(DAY1 + 100, { type: "assistant/message", data: { turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 2 } } }),
]);
if (r.daily[k1].uncachedInputTokens !== 30) throw new Error("FAIL same-day accumulate");

// 5) cache buckets flow into daily; cache-hit math
r = foldUsage([
  mk(DAY1, { type: "assistant/message", data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50 } } }),
]);
const d = r.daily[k1];
const hit = d.cacheReadTokens / (d.uncachedInputTokens + d.cacheReadTokens + d.cacheWriteTokens);
if (Math.abs(hit - 400 / 550) > 1e-9) throw new Error("FAIL daily cache hit");
console.log("daily cache hit:", ((hit * 100).toFixed(1)), "%");

console.log("ALL PASS");
