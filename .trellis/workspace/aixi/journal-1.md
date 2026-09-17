# Journal - aixi (Part 1)

> AI development session journal
> Started: 2026-09-16

---



## Session 1: usage-bar: align with official plugin contracts and make accounting idempotent
<!-- trellis-session: v=2 fp=44183acdd985d36e -->

**Date**: 2026-09-17
**Task**: usage-bar: align with official plugin contracts and make accounting idempotent

### Summary

Replaced accumulate-and-refold accounting with a per-session ledger read through ctx.sessionPersistence; fixed double-counting, DSH_HOME resolution, route trust fence, theme tokens, and timer ownership.

### Main Changes

- src/index.js: per-session ledger (recompute-and-replace); identity unified on session.id; history read via ctx.sessionPersistence list/open/read; reset is an epoch watermark + per-entry floor; routes get kind:exact, method checks, connection.requestRejection fence, POST reset with header nonce; timers owned by ctx.effect; store path honors DSH_HOME
- src/client/index.js: data-plugin-css style attribution; replaced undeclared theme tokens with --dsw-alias-brand-primary and --dsw-alias-bg-layer-2; panel follows scroll; removed redundant memo dep
- package.json: dropped bogus types entry and no-op dsh.client.inject, added cordis peer, version 0.2.0
- tests: added selftest-idempotence, selftest-integration, selftest-timers; rewrote selftest-reset to drive real handlers; extended selftest-rail and selftest-migrate
- .trellis/spec/frontend/dsh-plugin-contracts.md: captured verified bundle/host/client contracts with citations

### Git Commits

(No commits - planning session)

### Testing

- [OK] 9/9 selftests pass (selftest.mjs, -daily, -reset, -sumdaily, -migrate, -rail, -idempotence, -integration, -timers)
- [OK] Falsifiability proven by reverting each fix: old model inflated 2.0x; fence removal -> 'fence status 401 must be propagated'; nonce gate removal -> 'bad nonce must be 403 (got 200)'; timer disposer removal -> 'timers still live after dispose: 1'

### Status

[OK] **Completed**

### Next Steps

- Consider sessionProjections.stateOf as a live accelerator (performance only)
- Consider migrating the ledger onto ctx.storage / dsh-storage-domain
- Add a warning log when the store is permanently unwritable (persist currently fails soft and silent)


## Session 2: usage-bar: idempotent accounting, official contracts, live verification, and push
<!-- trellis-session: v=2 fp=d41313b647a7f5ec -->

**Date**: 2026-09-17
**Task**: usage-bar: idempotent accounting, official contracts, live verification, and push
**Branch**: `main`

### Summary

Rewrote the plugin's accounting as a per-session ledger read through ctx.sessionPersistence, aligned every route and client convention with the installed dsh 0.1.5-rc.2, verified against a real dsh web boot, and pushed to GitHub.

### Main Changes

- src/index.js: per-session ledger (recompute-and-replace) so live and backfill can never double-count; history via ctx.sessionPersistence list/open/read; reset as an epoch watermark plus per-entry floor; kind:exact plus method checks plus connection.requestRejection on all four routes; POST reset with a header nonce; timers owned by ctx.effect; persist failures reported once; store path honors DSH_HOME
- src/client/index.js: data-plugin-css style attribution; replaced two undeclared theme tokens; panel follows scroll
- tests: 13 selftests covering idempotence, ledger invariants, route contract, timer ownership, persist failure, store size, and executable spec claims
- spec: dsh-plugin-contracts.md (verified host/client contracts with citations) and usage-bar-contracts.md (7-section executable code-spec)

### Git Commits

| Hash | Message |
|------|---------|
| `713a386` | fix: make token accounting idempotent and align with dsh plugin contracts |
| `960ecfb` | test: cover accounting idempotence, route contracts, and failure paths |
| `fe0ee94` | docs: record verified plugin contracts and an executable code-spec |
| `c8df83f` | chore(trellis): add task artifacts and project scaffolding |
| `bf032a4` | chore(trellis): add workflow config, scripts, and spec scaffold |

### Testing

- [OK] 13/13 selftests pass; build in sync
- [OK] Live dsh web boot against an isolated DSH_HOME: fence 401, kind:exact proven by a 404 on a suffixed path, 405+Allow, 403 bad nonce, reset survives a real restart with no re-inflation
- [OK] Real-DOM render (jsdom + react-dom) of the served bundle; Chrome cannot launch in this sandbox (mojo IPC denied) so pixel checks are handed to ui-preview.html
- [OK] Falsifiability verified by reverting each fix: 2.0x inflation, 'fence status 401 must be propagated', 'bad nonce must be 403 (got 200)', 'timers still live after dispose: 1'

### Status

[OK] **Completed**

### Next Steps

- Confirm pixel rendering by opening .trellis/tasks/archive/2026-09/09-17-usage-bar-contract-alignment/ui-preview.html in a real browser
- Decide whether the 5 commits should be authored as lsl1931 instead of Imjac1 (requires amend + force push)
- Consider migrating the ledger onto ctx.storage for atomic writes
