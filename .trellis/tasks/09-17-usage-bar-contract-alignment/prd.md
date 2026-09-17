# dsh-usage-bar: align with official plugin contracts and make accounting idempotent

## Goal

Make the plugin's usage numbers correct and stable (never double-counted, never lost,
never resurrected by a restart), read its data through the harness's own session
persistence instead of hand-rolled filesystem scanning, and adopt the official plugin
contracts for routing, security, styling, and lifecycle.

## Background

The plugin aggregates provider-reported token usage into a sidebar pill plus a
calendar heatmap. The folding semantics it implements match the official
`tokenUsage` projection exactly (verified against real logs: 10 files, 0 divergences),
but the way it *accumulates* that fold is not idempotent, and the way it *finds* the
data does not match how the harness stores it.

## Requirements

### R1 — Accounting must be idempotent

Re-observing the same session must not change any displayed number. Specifically:

- R1.1 A session counted while the plugin was live must not be counted again by a
  later backfill pass (same boot or after a restart).
- R1.2 A session that is resumed/reopened must not be double-counted.
- R1.3 An interrupted backfill or migration must be safely retryable; a partial pass
  must not leave a partial contribution behind.

### R2 — Data must come from the harness's own session storage

- R2.1 Resolve the session-log location the same way the harness does. The current
  hardcoded `~/.dsh` ignores `$DSH_HOME` and is wrong on the reporting machine.
- R2.2 Read the *current* session-log generation, not a stale one. Logs are addressed
  as `session.v{N}.jsonl.zstd` with the highest N authoritative.
- R2.3 Use one session identity key everywhere. Backfill and live capture currently
  key the same session differently, so deduplication cannot work.

### R3 — 清零 (reset) must keep its documented promise

- R3.1 Resetting zeroes the "本次统计" counter without touching history.
- R3.2 A restart after a reset must not replay history back into the cleared counter.
- R3.3 The calendar and "历史累计" tab are unaffected by a reset.

### R4 — Routes must follow the official host-route contract

- R4.1 Every route declares its kind and rejects unsupported methods.
- R4.2 Every route passes the harness trust/auth fence before doing work.
- R4.3 The reset route is not a GET and does not carry its secret in the URL.
- R4.4 The reset secret is not handed out by an unauthenticated endpoint.

### R5 — Client must follow the official styling and lifecycle conventions

- R5.1 Injected stylesheet is tagged so the client module system can attribute it.
- R5.2 Colors use theme tokens that actually exist in the harness theme.
- R5.3 Timers and subscriptions are owned by the plugin fiber and torn down with it.

### R6 — Package manifest must be valid and honest

- R6.1 Declared type entry points exist.
- R6.2 Declared client dependencies are real graph rows (or dropped).
- R6.3 Runtime peer requirements are declared.

### R7 — Behavior must be covered by tests that can fail

- R7.1 Regression tests cover R1.1–R1.3 and R3.1–R3.2.
- R7.2 The reset test exercises the real implementation, not a copy of it.

## Constraints

- C1 Zero new runtime dependencies. Node >= 22, no bundler, no transpiler.
- C2 The client half stays JSX-free (`React.createElement`) and CJS-factory form.
- C3 The official fold semantics (`foldUsage` over usage events) must not change;
  they are already correct and verified.
- C4 Existing public module exports (`foldUsage`, `sumDaily`, `decodeSessionLog`,
  `dayKeyOf`) keep their signatures and behavior.
- C5 The sidebar slot choice and rail-mode geometry are already correct and are out
  of scope.
- C6 The project root is not a Git repository; no commit step is possible.

## Acceptance Criteria

- [ ] AC1 Boot 1 with an empty store, run a session live, restart: the pill shows that
      session's usage exactly once (today it shows it twice).
- [ ] AC2 A session whose log is present before the backfill pass runs is counted once,
      not once by live capture plus once by backfill.
- [ ] AC3 An interrupted backfill pass, re-run to completion, produces the same totals
      as an uninterrupted pass.
- [ ] AC4 With `$DSH_HOME` pointing at a non-default directory, the plugin reports the
      sessions stored there (today it reports zero).
- [ ] AC5 A session that exists only as `session.v3.jsonl.zstd` is counted (today it is
      skipped), and a session with both v2 and v3 generations is counted from v3.
- [ ] AC6 Reset then restart: the pill reads zero and stays zero; calendar and
      "历史累计" are unchanged across the reset.
- [ ] AC7 `GET /dsh-usage-bar/summary/anything` does not resolve to the summary route.
- [ ] AC8 A request to any plugin route from an untrusted host or without browser
      authentication is rejected before the handler runs.
- [ ] AC9 Reset is not reachable by a plain GET with no body.
- [ ] AC10 The injected `<style>` element carries the plugin-css tag attribute.
- [ ] AC11 No color in the injected CSS references a token that is undeclared in the
      harness theme.
- [ ] AC12 Disabling/unloading the plugin clears its timers (no writes after unload).
- [ ] AC13 `node build.mjs && node selftest*.mjs` all pass, including the new
      idempotence tests.
- [ ] AC14 Deleting the reset implementation makes the reset test fail.

## Out of Scope

- Any change to the visual design, layout, or rail-mode behavior.
- Migrating storage onto `ctx.storage` / `dsh-storage-domain` (see design.md: deferred).
- Using `sessionProjectionCache` as a zero-I/O fast path (see design.md: deferred).
- Filling `.trellis/spec/frontend/` (tracked by `00-bootstrap-guidelines`).
