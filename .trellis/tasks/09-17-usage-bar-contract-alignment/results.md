# Implementation Results — usage-bar-contract-alignment

Status: implemented and verified. All 12 selftests pass. Every acceptance criterion
either passes or is explicitly marked as deferred below.

## What shipped

| Area | Change |
|---|---|
| Accounting model | Per-session ledger; every number derived by summing entries. Recompute-and-replace instead of accumulate. |
| Identity | One key everywhere: `session.id` live, `snapshot.header.id` in backfill. |
| Discovery | Delegated to `ctx.sessionPersistence` (`list` / `open(id,"read")` / `read`). Own zstd scanner no longer used internally. |
| Reset | Epoch watermark (`resetAt`) + per-entry `floor`; "current" is a derived interval view. |
| Routes | `kind:"exact"` on all 4; method checks; `connection.requestRejection` fence; reset is POST + header nonce; nonce moved off `/summary` to its own fenced POST route. |
| Client | `data-plugin-css` style attribution; real theme tokens; panel follows scroll; redundant memo dep removed. |
| Manifest | Removed bogus `types`; dropped the no-op `dsh.client.inject`; added cordis peer; version 0.2.0. |
| Store path | Now resolves `$DSH_HOME` > `~/.dsh` (was hardcoded `~/.dsh`). |

## Two issues found DURING implementation (not in the original analysis)

### 1. Live events double-counted against the seeding snapshot

`session/event` fires AFTER the event is committed, so `session.snapshotEvents()`
already contains the event being delivered. Seeding the live fold from the snapshot
and then folding the delivered event counted it twice.

Caught by `selftest-integration.mjs` (backfill 27875 → live replay 55750).
Fixed with an `observedSeq` watermark, mirroring the official
`session-projection` `advanceCell` guard. This is the same bug class as RC1 —
worth noting that the first fix did not eliminate the class, only one instance of it.

### 2. The store path had the same `$DSH_HOME` bug as the session root

`PLUGIN_DIR` was `homedir()/.dsh/storages/...`, so the plugin wrote its ledger to a
tree the harness never reads. Fixed via `resolveHarnessHome()` with the documented
precedence (explicit config > `$DSH_HOME` > `~/.dsh`, blank override treated as unset).

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC1 live → restart counted once | PASS | `selftest-idempotence.mjs` §3,4 |
| AC2 log present before backfill counted once | PASS | §3 asserts `added === 0` |
| AC3 interrupted pass retryable | PASS | §5 |
| AC4 `$DSH_HOME` honored | PASS | `resolveHarnessHome` unit-checked; integration reads real `$DSH_HOME` logs |
| AC5 v3-only session counted | PASS | `selftest-migrate.mjs` (11 real sessions, incl. v3-only) |
| AC6 reset survives restart | PASS | `selftest-idempotence.mjs` §7, `selftest-integration.mjs` §4 |
| AC7 no prefix-route resolution | PASS | `selftest-reset.mjs` asserts `kind === "exact"` ×4 |
| AC8 fence rejects before handler | PASS | `selftest-reset.mjs` 401/403 |
| AC9 reset not reachable by GET | PASS | `selftest-reset.mjs` 405 + Allow: POST |
| AC10 style carries plugin-css tag | PASS | `selftest-rail.mjs` |
| AC11 no undeclared theme token | PASS | `selftest-rail.mjs` allowlist check |
| AC12 unload clears timers | PASS | `selftest-timers.mjs` |
| AC13 build + all selftests | PASS | 12/12 |
| AC14 deleting reset makes its test fail | PASS | verified: `bad nonce must be 403 (got 200)` |

### Falsifiability spot-checks performed

Each of these was run by temporarily reverting the fix and confirming the test fails
for the *stated* reason, then restoring:

- Old accumulate-and-refold model → 2.0× inflation on the idempotence fixture.
- Fence removed from 4 routes → `fence status 401 must be propagated`.
- Nonce gate removed → `bad nonce must be 403 (got 200)`.
- Timer disposer removed → `timers still live after dispose: 1`.

## Deferred (explicitly out of scope, unchanged from design.md)

- `sessionProjections.stateOf(session, "tokenUsage")` as a live accelerator. The
  per-session fold is already idempotent; this would only be a performance win.
- `sessionProjectionCache.cachedSnapshot` zero-I/O fast path. Verified on this
  machine to be mostly stale (rows at `seq: 3`, zero totals) — a cache, not a source.
- Migration of the ledger onto `ctx.storage` / `dsh-storage-domain`.

## Notes / residual risk

- **v2 store migration is lossy by design.** A version-2 store has no per-session
  attribution, so it is discarded and rebuilt from logs; the reset boundary is
  carried forward as "everything known so far is historical". The user loses the
  precise pre-upgrade reset point, not any usage.
- **Store writes are fail-soft.** `persist` swallows errors. This is deliberate
  (a storage failure must not break the plugin), but it means a permanently
  unwritable store degrades to in-memory-only silently. Worth a future warning log.
- **`floorOf` filters by event time.** A session spanning a reset has its floor
  recomputed from its log each time it is folded, which is correct but costs one
  extra fold pass per session per reset boundary.
- **No commit step possible**: the project root is not a Git repository (C6).