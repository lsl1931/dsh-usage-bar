# usage-bar Contracts (code-spec)

> Executable contracts for this plugin's Node half, client half, and persisted store.
> Companion to [dsh-plugin-contracts.md](./dsh-plugin-contracts.md), which explains
> *why* the harness requires these shapes. This file states the exact signatures,
> payloads, and failure behaviour.

---

## 1. Scope / Trigger

Applies when changing any of:

| Change | Affected section |
|---|---|
| A route path, method, or response body | §3.1, §4.1 |
| The persisted store schema or version | §2.1, §4.2 |
| A function exported from `src/index.js` | §2.3 |
| The client's data shape or fetch calls | §3.2, §4.3 |
| The `package.json` `dsh` block | dsh-plugin-contracts.md |

---

## 2. Signatures

### 2.1 Persisted store (v3)

Path: `<DSH_HOME>/storages/dsh-usage-bar/usage.json`

```jsonc
{
  "version": 3,
  "resetAt": 0,                    // epoch-ms of the last 清零; 0 = never reset
  "sessions": {
    "session-<uuid>": {            // key IS session.id, never a stripped form
      "totals": { "uncachedInputTokens": 0, "outputTokens": 0,
                  "cacheReadTokens": 0, "cacheWriteTokens": 0 },
      "daily":  { "YYYY-MM-DD": { /* same 4 fields */ } },
      "floor":  { /* same 4 fields: the part predating resetAt */ }
    }
  }
}
```

**Invariants** (asserted by `selftest-ledger-invariants.mjs`):

- `sum(entry.daily) === entry.totals` for every entry.
- `entry.floor <= entry.totals` componentwise.
- `daily` keys are local-calendar `YYYY-MM-DD`.
- A v2 file (which had no `sessions`) is discarded and rebuilt from logs;
  `resetAt` is set to now so known usage counts as historical.

### 2.2 HTTP routes

All four are `kind: "exact"` and pass the trust fence before any work.

| Method | Path | Success | Body |
|---|---|---|---|
| GET | `/dsh-usage-bar/summary` | 200 | `{ current, allTime, backfilledSessions, resetAt }` |
| GET | `/dsh-usage-bar/daily` | 200 | `{ daily: { "YYYY-MM-DD": [uncached, output, cacheRead, cacheWrite] } }` |
| POST | `/dsh-usage-bar/nonce` | 200 | `{ nonce: string }` |
| POST | `/dsh-usage-bar/reset` | 200 | `{ ok: true }` |

`current` and `allTime` share the shape
`{ totals, billedInputTokens, totalTokens }` where
`billedInputTokens = uncached + cacheRead + cacheWrite` and
`totalTokens = billedInputTokens + output`.

### 2.3 Module exports (`src/index.js`)

```ts
export const inject: ["webServer", "connection"];
export function apply(ctx): void;

// pure folds — signatures frozen (constraint C4)
export function foldUsage(events): { totals, daily };
export function sumDaily(daily): totals;
export function decodeSessionLog(buf: Buffer): object[];
export function dayKeyOf(ms: number): string | null;

// ledger
export function emptyStore(): Store;
export function backfillOnce(store, sessions: AsyncIterable<{id, events}>): Promise<number>;
export function persistedSessions(persistence, store): AsyncIterable<{id, events}>;
export const allTimeTotals: (store) => totals;
export const currentTotals: (store) => totals;
export function allTimeDaily(store): Record<string, totals>;
export function resolveHarnessHome(env?): string;
```

---

## 3. Contracts

### 3.1 Request boundary

| Aspect | Contract |
|---|---|
| Trust | `ctx.connection.requestRejection(req)` returns `undefined` (allow) or 401/403 |
| Method | Non-matching method → 405 with `Allow` header |
| Reset secret | Header `x-dsh-usage-bar-nonce`; never a query param |
| Cache | All responses `cache-control: no-store` |

### 3.2 Client → host

| Client call | Expects |
|---|---|
| `GET /summary` | `data.current.totals` present; absence → render nothing |
| `GET /daily` | `{ daily }`; missing → `{}` |
| `POST /nonce` | `{ nonce }` cached in module state |
| `POST /reset` | 200; on any failure keep the previous display |

### 3.3 Environment

| Variable | Contract |
|---|---|
| `DSH_HOME` | Overrides the harness home. Blank/whitespace-only counts as **unset**. |
| (fallback) | `~/.dsh` |

Resolution order: explicit config (unavailable to a plugin) > `$DSH_HOME` > `~/.dsh`.

---

## 4. Validation & Error Matrix

| Condition | Behaviour | Must NOT |
|---|---|---|
| No browser auth / untrusted host | 401/403, empty body | run the handler body |
| Wrong method | 405 + `Allow` | mutate state |
| Reset without/with wrong nonce | 403 `bad_nonce` | change `resetAt` or any floor |
| `sessionPersistence` absent | live-only, no history | throw, or park the fiber |
| A session log unreadable | skip that session | abort the whole pass |
| A session dir with no log artifact | skip it | count it, or report an error |
| Store write fails (EPERM etc.) | warn **once** with the path, keep the in-memory ledger | throw, or lose in-memory state |
| Store file corrupt/unparseable | start from an empty store | throw at boot |
| Session has no `seq` on an event | fold it (no watermark update) | double-count a replayed event |

---

## 5. Good / Base / Bad Cases

**Good — a session observed live, then again by backfill**

```
live fold writes sessions["session-abc"] = {...}
backfill lists session-abc -> already in sessions -> skipped
=> totals unchanged
```

**Base — a fresh session on a machine with no history**

```
backfill lists nothing -> 0 added
live events fold incrementally -> totals grow
```

**Bad — accumulating deltas into a running total**

```js
// WRONG: backfill re-folds a session the live path already counted
store.totals.uncachedInputTokens += delta;
// measured result: exactly 2x the true value after a restart
```

---

## 6. Tests Required

| Contract | Test | Assertion point |
|---|---|---|
| §2.1 invariants | `selftest-ledger-invariants.mjs` | `sum(daily) === totals` per entry; sessions independent |
| Idempotence | `selftest-idempotence.mjs` | live-only == backfill-only == live+backfill == after-restart |
| Interrupted retry | `selftest-idempotence.mjs` §5 | partial pass + retry == uninterrupted |
| Reset boundary | `selftest-idempotence.mjs` §7, `selftest-reset.mjs` | current == 0 after restart; allTime unchanged |
| Routes + fence | `selftest-reset.mjs` | `kind === "exact"` ×4; 401/403; 405 + Allow; 403 bad nonce |
| Write failure | `selftest-persist.mjs` | no throw; ledger usable; exactly 1 warning |
| Store size | `selftest-store-size.mjs` | < 2 KB per session |
| Timer ownership | `selftest-timers.mjs` | zero timers live after dispose |
| Style attribution | `selftest-rail.mjs` | `data-plugin-css` set; only declared tokens |
| Real-log ingestion | `selftest-migrate.mjs` | second pass adds 0 |
| End-to-end | `selftest-integration.mjs` | backfill → live replay → reset via real `apply()` |

**This file is executable.** `selftest-spec-claims.mjs` asserts every claim in
§2.1-§3.3 against the real module — the export list, the env precedence, the route
kinds, the response field names and formulas, `cache-control`, the 405/`Allow` shape,
and that the fence actually gates. If you change a contract here, change the code and
that test together; a spec that drifts from the implementation is worse than none.

**Falsifiability is required for load-bearing assertions.** Revert the fix, confirm the
test fails for the *stated* reason. Verified this way: the idempotence invariant
(old model inflates 2.0x), the fence (`fence status 401 must be propagated`), the nonce
gate (`bad nonce must be 403 (got 200)`), timer ownership (`timers still live after
dispose: 1`).

---

## 7. Wrong vs Correct

### 7.1 Session identity

```js
// WRONG: the on-disk directory name minus its prefix
const id = sd.name.slice("session-".length);   // "d885e8de-…"

// RIGHT: the session's own id, from the live session or the stored header
const id = String(session.id);                  // "session-d885e8de-…"
// backfill: String(snapshot.header.id)
```

Mixing the two means deduplication can never match, which is the root of the
double-count.

### 7.2 Live event ordering

```js
// WRONG: seed from the snapshot, then fold the delivered event -> counted twice
const state = seedFrom(session.snapshotEvents());
foldApply(state, event);

// RIGHT: the snapshot already contains the delivered event
const state = seedFrom(session.snapshotEvents());  // observedSeq = max seq
if (seq <= state.observedSeq) return;              // already folded
foldApply(state, event);
```

### 7.3 Reading session logs

```js
// WRONG: hand-rolled path math and generation guessing
const root = join(homedir(), ".dsh", "sessions");           // ignores $DSH_HOME
readFileSync(join(dir, "session.jsonl.zstd"));              // misses session.v3.*

// RIGHT: let the harness own discovery
const handle = await ctx.get("sessionPersistence").open(id, "read");
const { events } = await handle.read();                     // decoded events
await handle.close();
```