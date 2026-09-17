# Technical Design — usage-bar-contract-alignment

## 1. Boundary statement

**The smallest behavior gap.** The plugin cannot answer "has this session's usage
already been counted?" So it counts sessions twice (live capture + backfill), and it
cannot find the sessions it should count, because it re-implements filesystem
discovery that the harness already owns.

**Where that behavior actually lives.** All of it in the Node half:
`apply()`'s live branch and `backfillOnce()` in `src/index.js`. The fold itself
(`foldUsage`) is already correct and verified — it is not the bug and must not change.

**Files that change**

| File | Why necessary |
|---|---|
| `src/index.js` | Home/generation/identity resolution, idempotent accounting, route contract, timer ownership, Config export |
| `src/client/index.js` | Style-tag attribution; two undeclared theme tokens |
| `package.json` | Bogus `types` target; ineffective `dsh.client.inject`; missing peers |
| `selftest-*.mjs` | New idempotence tests; reset test currently tests a copy, not the code |

**Explicitly not doing.** No visual/layout/rail changes. No change to `foldUsage` /
`sumDaily` / `decodeSessionLog` / `dayKeyOf` signatures or semantics. No new
dependencies. No migration onto `ctx.storage`. No use of `sessionProjectionCache`.

**How the refactor is proven behavior-preserving.** The four exported pure functions
keep their signatures; all six existing selftests must still pass unchanged. The new
idempotence test asserts the *same* event set produces the *same* totals whether it
arrives via live capture, via backfill, or via both.

---

## 2. Root causes (all verified on this machine)

| ID | Cause | Evidence |
|---|---|---|
| RC1 | Live capture folds deltas into `store.totals` but never marks the session; `backfilled` is only written by `backfillOnce` (`src/index.js:275`) | repro: live 300 → restart → 600 |
| RC2 | Backfill keys by `sd.name.slice("session-".length)` (`:251`); live keys by `String(session.id)` (`:313`). Real `header.id` === `session-<uuid>` | both keys printed side by side differ |
| RC3 | `homedir()/.dsh` hardcoded (`:149`, `:295`); harness uses `resolveDshHome()` = config > `$DSH_HOME` > `~/.dsh` | on this machine `$DSH_HOME` is set, `~/.dsh` does not exist → backfill finds 0 sessions |
| RC4 | Only `session.jsonl.zstd` / `session.jsonl` are tried (`:256`); generations are `session.v{N}.jsonl.zstd`, highest N wins | `67d54cd6`: v2=1,324,841 vs v3=2,856,461; `d885e8de` has only v3 → plugin reads 0 |
| RC5 | Interrupted daily migration keeps `dailyDone=false` but does not roll back what it already added (`:250-286`) | repro: 100 → interrupted → retry → 400 (truth 300) |
| RC6 | Routes omit `kind`, so all three land in the **prefix** table | `dsh-host-webserver/lib/index.js:177`: `route.kind === "exact" ? exact : prefixes` |
| RC7 | No trust/auth fence on any route; nonce served by unauthenticated `/summary` | official pattern: `dsh-host-open-in-app/lib/index.js:1316-1323` → `connection.requestRejection` |
| RC8 | `let saveTimer` at module scope (`:193`) and a bare `setTimeout` (`:452`) outside `ctx.effect` | official rule: SKILL.md:127-134; official pattern: `dsh-session-projection-cache/lib/index.js:306,319` |
| RC9 | Style tag uses `id`, not the `data-plugin-css` convention | `dsh-client-modules/lib/client.js:170-176` `claimStyles` adopts untagged tags for the next materializing plugin |
| RC10 | `--dsw-alias-text-accent` is declared **nowhere** (0 occurrences repo-wide); `--dsw-hovercard-bg` is a component-local variable in `HoverCard.module.css`, not a theme token | theme token table has 357 entries, neither is among them |
| RC11 | `exports["."].types` → `./lib/index.d.ts`, absent; `dsh.client.inject` lists `@deepseek-ai/dsh-client-ui-slots`, which has no `./client` export and no `dsh.client` declaration | `resolveMeta` returns null for it → the entry is a no-op |

## 3. Core decision: delegate storage discovery to the harness

The plugin currently owns four subsystems the harness already implements correctly:
home resolution, project-directory layout, generation selection, and zstd
multi-frame decoding. Each is a source of the bugs above.

**Chosen approach — read through `ctx.sessionPersistence`.**

Verified facts that make this viable:

- Service key is `"sessionPersistence"` (`dsh-session-persistence/lib/index.js:263`),
  mounted in the shared base layer (`dsh-base/cordis.patch.yml:110-113`).
- `open(id, "read")` resolves **by id alone** — `findLog` walks every project
  directory looking for `encodeSegment(id)` (`dsh-session-persistence-jsonl/lib/index.js:3239-3251`).
  No cwd, no path construction, no `$DSH_HOME` handling on our side. This makes RC3
  moot rather than fixed.
- Generation selection and v2→v3 migration happen inside `readStoredLog`
  (`:2682-2693`, revision-memoized). This resolves RC4 with no code of ours.
- `SessionHandle.read(offset, length)` returns **decoded event objects**
  (`:101-109` — `events: source.events.slice(offset, offset + length)`), and offset/
  length are event indices, not bytes. So the plugin's own `zstdFrames` /
  `decodeSessionLog` are no longer needed for the backfill path.
- `SessionPersistenceSnapshot` carries `header` (with `id`, `cwd`, `createdAt`)
  and `revision`, so `list()` gives identity plus a change token
  (`dsh-tool-cordis/lib/index.js:7462-7463`).

Optional dependency, per SKILL.md:100-125 — `sessionPersistence` is read with
`ctx.get()` and the plugin degrades to "no backfill" when absent, rather than
declaring a hard `inject` that would park the fiber:

```js
const persistence = ctx.get("sessionPersistence");
if (persistence === undefined) return;   // no history source: live capture still works
```

### 3.1 Idempotence (RC1 + RC2 + RC5)

Identity is the session id, uniformly, from `session.id` live and `snapshot.header.id`
in backfill. One marker set replaces the two-key confusion.

Accounting is made **recompute-per-session, not accumulate**:

- The store keeps `sessions: { <id>: { revision, totals, daily } }` — one entry per
  session, each tagged with the persistence revision it was computed from.
- Live capture no longer mutates grand totals. It updates only the *live* view, which
  the client already polls, and marks the session dirty.
- A session's contribution is (re)computed by folding its events, then **replacing**
  its previous entry rather than adding to a running sum. Grand totals and per-day
  buckets are derived by summing entries.

This is the property that was missing: re-observing a session is idempotent by
construction, because a session's entry is a pure function of its event log. RC1, RC2
and RC5 all disappear as a class, not as three separate patches.

Cost: a full re-fold per changed session. Bounded by only re-folding sessions whose
`revision` changed, and by folding on `session/disposed` rather than on every event.
Worst case on this machine (5 sessions, ~12MB) measured 782ms synchronously — so the
pass stays off the event path and is chunked (see §3.3).

### 3.2 Why not the two rejected alternatives

- **Use `ctx.sessionProjections.stateOf(session, "tokenUsage")` live.** Correct and
  idempotent, and it already exists. Rejected as the *sole* mechanism because it only
  answers for sessions the current process has in memory — the historical backfill
  still needs the log. Kept as an optional accelerator: when the projection key is
  present, the live view can read it instead of re-folding, which is strictly cheaper.
  Not required for correctness, so it is a follow-up, not a dependency.
- **Use `sessionProjectionCache.cachedSnapshot(...)` for a zero-I/O backfill.**
  Tempting, but the persisted rows are checkpointed only at session creation,
  `turn/end`, and disposal, and on this machine most rows are still at `seq: 3` with
  all-zero totals. It is a cache, not a source of truth. Deferred; noted as a possible
  fast path with a `revision`-based validity check.

### 3.3 Where the work runs

- Live: `session/event` keeps the existing cheap delta path for the *pill's* live
  number only (no store mutation).
- Durable: fold + replace on `session/disposed`, and on a debounced timer for
  long-running sessions so the pill's persisted value does not lag a whole session.
- Boot backfill: one async pass over `list()`, skipping sessions whose `revision`
  matches the stored entry. Chunked with `await` between sessions so the event loop
  is not blocked for ~800ms.

## 4. Reset semantics (RC: R3)

With per-session entries, "本次统计" is a *view* over entries created after an epoch
marker, not a separate accumulator:

- `epoch` stays (already present, `src/index.js:436`), and reset records
  `epochAt = <current revision watermark>` rather than zeroing a sum.
- "本次统计" = sum of entries with `lastSeen > epochAt`; "历史累计" = sum of all entries.
- A restart recomputes entries from logs but cannot move an entry across the epoch
  boundary, because the boundary is a stored timestamp/watermark, not a counter.
  This is what makes R3.2 hold structurally instead of by care.

Open question flagged for implementation: whether a *resumed* session that was
already counted before the reset should count as "current". Proposal: no — the epoch
is the session's last-seen watermark, so a session whose usage predates the reset
stays historical even if reopened. Recorded here because it is a product decision,
not a technical one.

## 5. Route contract (RC6 + RC7)

Adopt the official shape, copied from `dsh-host-open-in-app/lib/index.js:1316-1343`:

```js
const rejected = (req, res) => {
  const rejection = connectionOf(ctx).requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
};
ctx.effect(() => ctx.webServer.register({
  kind: "exact",                 // explicit: otherwise it lands in the prefix table
  path: "/dsh-usage-bar/summary",
  handler: async (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== "GET") { sendMethodNotAllowed(res, "GET"); return; }
    sendJson(res, 200, body);
  },
}), "dsh-usage-bar: summary route");
```

- `inject` gains `connection` — a genuine hard dependency now, since the fence is
  mandatory rather than optional.
- Reset becomes `POST` with the nonce in a request header, not the query string.
- The nonce stops being served by `/summary`. It moves to a `POST /dsh-usage-bar/nonce`
  that is itself behind the fence, or is dropped entirely if the fence alone is judged
  sufficient — **flagged as an open decision**; the fence is the real control and the
  nonce was compensating for its absence.

## 6. Client changes (RC9 + RC10)

- Style tag: `tag.dataset.pluginCss = tagId` plus a
  `style[data-plugin-css="<id>"]` presence check, matching the 38 official bundles.
- `--dsw-alias-text-accent` → `--dsw-alias-brand-primary` (declared, used by official
  components for accent). `--dsw-hovercard-bg` → `--dsw-alias-bg-layer-2` with
  `--dsw-elevation-prominent` for the shadow.
- Timers: `saveTimer` and the backfill timer move inside `ctx.effect` with
  `clearTimeout` in the disposer.

## 7. Manifest (RC11)

- Drop the `types` field (no `.d.ts` is shipped and none is generated) or emit one;
  dropping is the honest minimum for a JS-only package.
- Remove `@deepseek-ai/dsh-client-ui-slots` from `dsh.client.inject` — it is not a
  graph row, so the entry does nothing. Real cross-bundle dependencies belong in
  `dsh.client.external`, and this client half requires nothing but `react`.
- Add `peerDependencies` for `@deepseek-ai/cordis`.

## 8. Compatibility and rollout

- **Store format.** `version: 2` → `3` (per-session entries). A v2 store is read once,
  its `totals`/backfilled` used to seed the epoch boundary, then rewritten. If the
  migration is not obviously safe on read, discard and rebuild from logs — the logs
  are the source of truth, so nothing is lost except the reset boundary, which is
  reported to the user in the panel rather than silently reset.
- **Rollback.** `lib/` is generated from `src/`; reverting `src/` and re-running
  `node build.mjs` restores the previous behavior. No data migration is one-way.
- **Degradation.** No `sessionPersistence` → live pill only, no history, no error.
  No `connection` → routes refuse to register rather than registering unprotected.

## 9. Verification plan

Per acceptance criterion, with the mechanism that makes it fail if broken:

| AC | Mechanism |
|---|---|
| AC1, AC2 | New `selftest-idempotence.mjs`: fold a synthetic log through live, through backfill, and through both; assert identical totals |
| AC3 | Same file: run a pass with an injected mid-pass abort, re-run, assert equality with the uninterrupted result |
| AC4 | Run with `DSH_HOME` pointed at a temp dir holding a synthetic store; assert non-zero |
| AC5 | Synthetic session directory containing only `session.v3.jsonl.zstd` |
| AC6 | Extend `selftest-reset.mjs` (rewritten to import the real module) with a restart step |
| AC7, AC9 | Assert the registered route record has `kind === "exact"`; assert the reset handler is not reachable via GET |
| AC8 | Unit-test the fence helper with a stub `connection` returning 401/403 |
| AC10, AC11 | Extend `selftest-rail.mjs`'s DOM stub to assert the tag attribute; grep the injected CSS for token names against a declared-token list |
| AC12 | Assert every timer created during `apply()` is cleared by the fiber disposer |
| AC13 | `node build.mjs` then all `selftest*.mjs` |
| AC14 | Delete the reset handler body; the test must fail |

## 10. Sequencing

1. Identity + store schema + idempotent replace (RC1, RC2, RC5) — the correctness core.
2. `sessionPersistence` backfill (RC3, RC4) — now trivial once identity is unified.
3. Reset epoch semantics.
4. Route contract + fence (RC6, RC7).
5. Client style tag + tokens + timer ownership (RC8, RC9, RC10).
6. Manifest (RC11).
7. Tests, then `build.mjs`.

Steps 1-3 are one coherent change to `src/index.js` and must land together; steps
4-6 are independent and could be deferred without leaving the plugin inconsistent.
