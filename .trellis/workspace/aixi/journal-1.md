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
