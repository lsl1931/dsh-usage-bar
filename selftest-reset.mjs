// Verify the reset handler's nonce gate and zeroing without booting dsh.
const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const store = { totals: { ...ZERO }, backfilled: new Set(["x"]), epoch: 0 };
const resetNonce = "launch-abc123";

function resetHandler(url, res) {
  if (url?.includes(`n=${resetNonce}`) !== true) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "bad_nonce" }));
    return;
  }
  store.totals = { ...ZERO };
  store.epoch += 1;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
}

function makeRes() {
  return {
    _status: 0,
    writeHead(code) { this._status = code; },
    end() {},
  };
}

// 1) wrong nonce -> 403, totals untouched, epoch unchanged
store.totals.uncachedInputTokens = 100;
let r1 = makeRes();
resetHandler("/dsh-usage-bar/reset?n=wrong", r1);
console.log("wrong nonce:", r1._status, "totals:", store.totals.uncachedInputTokens, "epoch:", store.epoch);
if (r1._status !== 403 || store.totals.uncachedInputTokens !== 100 || store.epoch !== 0) {
  console.error("FAIL wrong nonce gate");
  process.exit(1);
}

// 2) missing nonce -> 403
store.totals.uncachedInputTokens = 50;
let r2 = makeRes();
resetHandler("/dsh-usage-bar/reset", r2);
console.log("missing nonce:", r2._status, "totals:", store.totals.uncachedInputTokens);
if (r2._status !== 403) { console.error("FAIL missing nonce"); process.exit(1); }

// 3) correct nonce -> zeroed, epoch bumped, backfilled preserved
let r3 = makeRes();
resetHandler("/dsh-usage-bar/reset?n=launch-abc123", r3);
console.log("correct nonce:", r3._status, "totals:", JSON.stringify(store.totals), "epoch:", store.epoch, "backfilled:", [...store.backfilled].join(","));
if (r3._status !== 200 || store.totals.uncachedInputTokens !== 0 || store.epoch !== 1 || store.backfilled.size !== 1) {
  console.error("FAIL correct nonce");
  process.exit(1);
}

console.log("ALL PASS");
