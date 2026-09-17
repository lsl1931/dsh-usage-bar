# Implementation Plan — usage-bar-contract-alignment

Read `design.md` first. Steps are ordered by dependency; each has its own verification.
Steps 1-3 are one atomic change to `src/index.js` and must land together.

## Preconditions

- `node --version` >= 22
- Baseline is green: `node build.mjs && node selftest.mjs && node selftest-daily.mjs && node selftest-reset.mjs && node selftest-sumdaily.mjs && node selftest-migrate.mjs && node selftest-rail.mjs`
- `$DSH_HOME` is set on this machine and `~/.dsh` does not exist — this is the RC3 repro fixture, not a thing to fix in the environment.

## Step 0 — Baseline capture

- [ ] Record current selftest output verbatim.
- [ ] Record the RC1 repro numbers (live → restart → inflated) so the fix can be shown to change them.

**Verify:** all six selftests pass before any edit.

---

## Step 1 — Unified identity and idempotent store (RC1, RC2, RC5)

- [ ] Replace `backfilled: Set<string>` with `sessions: { <id>: { revision, totals, daily } }`.
- [ ] Key by `session.id` live and `snapshot.header.id` in backfill. Delete the
      `slice("session-".length)` derivation entirely.
- [ ] Grand totals and per-day buckets become **derived** sums over `sessions`, not
      accumulators. Remove `addBuckets(store.totals, ...)` from the live path.
- [ ] Recompute-and-replace per session: fold its events, overwrite its entry.
- [ ] Store `version: 3`; read `version: 2` by seeding the epoch boundary from its
      `totals`, then rewrite.

**Verify:**
- New `selftest-idempotence.mjs`: same event set via live-only, backfill-only, and
  live+backfill must yield identical totals (AC1, AC2).
- Interrupted-pass test: abort mid-pass, re-run, assert equality with uninterrupted (AC3).
- `selftest-sumdaily.mjs` must still pass — the sum-over-entries invariant is the
  same invariant it already asserts.

**Rollback point:** this step alone. `git` is unavailable, so snapshot `src/index.js`
to a scratch file before editing.

---

## Step 2 — Backfill through sessionPersistence (RC3, RC4)

- [ ] `const persistence = ctx.get("sessionPersistence")`; return early when absent.
- [ ] `await persistence.list()` for snapshots; skip entries whose stored `revision`
      is unchanged.
- [ ] For each changed session: `await persistence.open(id, "read")`, `read()` the
      events, fold, replace entry, `close()`.
- [ ] Delete `zstdFrames` and the manual artifact-name probing. Keep
      `decodeSessionLog` **only** if a caller still needs it — otherwise keep it as a
      retained export (C4) but stop using it internally.
- [ ] Chunk with `await` between sessions; never fold synchronously in one tick.

**Verify:**
- AC4: run with `DSH_HOME` at a temp fixture; totals non-zero.
- AC5: fixture with only `session.v3.jsonl.zstd` is counted; fixture with both
  generations is counted from v3.
- Measured cost on real data stays ~the same (~800ms total) but no longer blocks a
  single tick.

**Rollback point:** reverting this step alone leaves Step 1's idempotence intact and
history simply absent — a safe partial state.

---

## Step 3 — Reset as an epoch watermark

- [ ] Replace `store.totals = {...ZERO}` with recording the reset watermark.
- [ ] "本次统计" = entries seen after the watermark; "历史累计" = all entries.
- [ ] Keep `epoch` for the in-flight-scan cancellation it already implements — do not
      drop it, it is load-bearing for the interrupted-pass case.

**Verify:**
- AC6: reset → restart → pill still zero, calendar and all-time unchanged.
- The existing nonce-gate behavior in `selftest-reset.mjs` must survive the rewrite.

**Open decision carried from design §4:** a resumed session that predates the reset
counts as historical. Confirm with the user before shipping; the alternative is to
count it as current.

---

## Step 4 — Route contract (RC6, RC7)

- [ ] Add `kind: "exact"` to all three routes.
- [ ] Add `connection` to `inject`; add the `connectionOf` + `rejected` helpers.
- [ ] Method-check every handler; add a `sendMethodNotAllowed` equivalent.
- [ ] Reset becomes `POST`; move the nonce out of the query string.
- [ ] Stop serving the nonce from `/summary`.

**Verify:**
- AC7: `GET /dsh-usage-bar/summary/anything` does not hit the summary handler.
- AC8: stub `connection` returning 401/403 → handler body never runs.
- AC9: plain GET to reset is rejected.

**Rollback point:** independent of Steps 1-3; can be deferred without inconsistency.

---

## Step 5 — Client conventions (RC8, RC9, RC10)

- [ ] `tag.dataset.pluginCss = tagId`; presence check via
      `style[data-plugin-css="<id>"]`.
- [ ] `--dsw-alias-text-accent` → `--dsw-alias-brand-primary`.
- [ ] `--dsw-hovercard-bg` → `--dsw-alias-bg-layer-2`; shadow →
      `--dsw-elevation-prominent`.
- [ ] Move `saveTimer` and the backfill timer into `ctx.effect` with `clearTimeout`.

**Verify:**
- AC10, AC11: extend `selftest-rail.mjs`'s DOM stub.
- AC12: assert the disposer clears every timer created during `apply()`.
- `selftest-rail.mjs`'s existing assertions must still pass — this step must not
  change rail geometry.

**Rollback point:** independent; CSS-only changes are trivially revertible.

---

## Step 6 — Manifest (RC11)

- [ ] Remove the `types` field (or generate a `.d.ts`; removal is the honest minimum).
- [ ] Drop `@deepseek-ai/dsh-client-ui-slots` from `dsh.client.inject`.
- [ ] Add `peerDependencies` for `@deepseek-ai/cordis`.

**Verify:** `node -e "require('./package.json')"` parses; every declared path exists.

---

## Step 7 — Full verification

- [ ] `node build.mjs`
- [ ] All `selftest*.mjs` pass, including the two new/extended ones.
- [ ] AC14: delete the reset handler body → the reset test fails. Restore it.
- [ ] Walk AC1-AC14 in `prd.md` and mark each one.

## Step 8 — Wrap-up

- [ ] Write findings back to `.trellis/spec/frontend/` — the bootstrap task
  (`00-bootstrap-guidelines`) is the right home for the conventions this work
  established (style-tag attribution, theme-token validation, timer ownership).
- [ ] No commit step: the project root is not a Git repository (constraint C6).

## Out of scope (do not drift into these)

- Visual/layout/rail changes.
- Migrating storage to `ctx.storage` / `dsh-storage-domain`.
- `sessionProjectionCache` fast path.
- Using `sessionProjections.stateOf` as the live accelerator — a good follow-up,
  not needed for correctness.
- Filling the frontend spec beyond the conventions this work actually establishes.
