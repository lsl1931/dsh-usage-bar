# Follow-up pass — performance, failure reporting, and the deferred items

Continues from `results.md`. Everything here was measured or verified, not assumed.

## 1. A real performance defect, found by measuring

I had claimed the accounting model was fine for the live path. Measuring it showed
otherwise.

**Benchmarking mistake first.** My initial benchmark reported ~0.0us per event, which
was implausible. The cause: my fixture returned the FULL event list from
`snapshotEvents()` on every call, so the first delivery seeded `observedSeq` to the
maximum and every later event took the early return. The real harness appends the
event before emitting `session/event`, so the snapshot grows. Re-benchmarking with a
growing snapshot exposed the true cost.

**The defect.** `flushSession` deep-cloned the per-day map on **every usage event** —
O(days) work per event, so per-event cost grew with how many distinct days a session
had spanned:

| Scenario | Before | After |
|---|---|---|
| typical (2 days, 100 events) | 0.6ms total · 5.8us/event | 0.4ms · 3.9us |
| medium (30 days, 1,500 events) | 6.9ms · 4.6us | 1.7ms · 1.1us |
| many days (200 days, 10,000 events) | **167.4ms · 16.7us** | **4.3ms · 0.4us** |
| adversarial (365 days, 36,500 events) | **1083.0ms · 29.7us** | **10.9ms · 0.3us** |

**Fix.** The ledger entry now shares the fold state's `daily` map by reference instead
of cloning it. Both objects are plugin-owned and mutated only by `foldApply`, so
sharing is safe. `totals`/`floor` are 4-field objects and still copied (free).
Per-event cost is now flat in day count.

The clone is retained on the **load** path, where isolation from freshly parsed JSON
genuinely matters — that is the correct place for it.

**Guarded.** Reference sharing is exactly where a subtle bug would hide, so
`selftest-ledger-invariants.mjs` asserts the invariant it could break:
`sum(daily) === totals` per ledger entry, two sessions summing independently, and the
floor never exceeding totals. All pass.

## 2. Closed a previously-deferred item: silent write failure

`results.md` flagged that `persist` swallowed errors, so a permanently unwritable
store degraded to in-memory-only with no signal. Now the first failure is logged with
the path and the failure count is tracked; the function still returns normally, so the
fail-soft contract is unchanged.

Verified end-to-end by accident and then on purpose: the sandbox denies writes to the
real harness home, so `selftest-persist.mjs` exercises the genuine failure path:

```
no throw on the persist path: OK
in-memory ledger usable after a write attempt: {"uncachedInputTokens":100,...}
warnings emitted: 1
   dsh-usage-bar: could not persist the usage ledger to C:\Users\...\usage.json (Error: EPERM: ...
```

Non-fatal, reported once (not per attempt), ledger still correct.

## 3. Store size verified proportional

The old v2 shape kept an unbounded `backfilled` id array re-serialized in full on
every save. `selftest-store-size.mjs` simulates 200 sessions × 5 active days:

```
200 sessions x 5 days -> 159,838 bytes (156.1 KiB)
per session: 799 bytes
per day-bucket: 160 bytes
old backfilled id array alone: 8,601 bytes
```

Size tracks real usage; the unbounded-array concern is gone with the v2 shape.

## 4. Test suite now 12 files

| File | Guards |
|---|---|
| `selftest.mjs` | fold semantics + real-log decode |
| `selftest-daily.mjs` | same-day replace, midnight correction, retry, per-day hit rate |
| `selftest-reset.mjs` | reset semantics + route contract (drives the real handlers) |
| `selftest-sumdaily.mjs` | daily sum == total |
| `selftest-migrate.mjs` | real-log ingestion + second pass is a no-op |
| `selftest-rail.mjs` | rail rendering, CSS constraints, style attribution, theme tokens |
| `selftest-idempotence.mjs` | live/backfill/restart/interrupted-retry invariants |
| `selftest-integration.mjs` | end-to-end through the real `apply()` |
| `selftest-ledger-invariants.mjs` | **new** — ledger consistency under shared maps |
| `selftest-persist.mjs` | **new** — write failure is non-fatal and reported |
| `selftest-store-size.mjs` | **new** — store size proportional to usage |
| `selftest-timers.mjs` | every timer `apply()` creates is cleared by its fiber |

12/12 pass.

## Still deferred (unchanged, with reasons)

- **`sessionProjections.stateOf` as a live accelerator.** The per-session fold is now
  measurably cheap (0.3–3.9us/event), so this is no longer worth the coupling.
  Revisit only if a session with very many days shows up in practice.
- **`sessionProjectionCache` zero-I/O fast path.** Verified on this machine to be
  mostly stale (rows at `seq: 3`, zero totals). A cache, not a source of truth.
- **Migrating the ledger onto `ctx.storage` / `dsh-storage-domain`.** Would give
  atomic writes and a schema contract for free. Not needed for correctness; the
  hand-rolled atomic rename + the size check above cover the practical risk.
- **Pixel-level rendering.** Cannot be produced in this sandbox (Chrome mojo IPC
  denied). `ui-preview.html` hands the check to a real browser.