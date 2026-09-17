# DSH Plugin Contracts

> Conventions for this plugin, verified against the installed dsh 0.1.5-rc.2 rather
> than inferred. Each rule cites the file that enforces it, so it can be re-checked
> after a dsh upgrade.

---

## Why this file exists

This plugin is a **bundle** (a profile layer) with a **dual-face package**: a Node
half (`lib/index.js`) and a browser half (`lib/client.js`). Both halves are loaded by
harness machinery that validates declarations and fails loud. Guessing any of these
contracts produces either a silent no-op or a boot failure.

When a rule below is violated, the failure mode is listed — that is the part worth
remembering, because several of these fail *silently*.

---

## Package manifest

| Field | Rule | Failure if wrong |
|---|---|---|
| `dsh.bundle.patch` | Required. Points at the bundle's patch YAML. | Profile fails to boot: `declares no dsh.bundle` (`dsh-app-boot/lib/index.js:884`) |
| `dsh.client.platform` | `"web"` to be discovered as a browser half. | Silently not loaded (`dsh-client-modules/lib/index.js:676`) |
| `exports["./client"]` | Required when `dsh.client` is declared. | Throws: `declares dsh.client but exports no "./client" bundle` (`:681`) |
| `exports["."].types` | Only if the file exists. | Type resolution fails; prefer omitting |
| `dsh.client.inject` | Only names that are **graph rows** (packages with their own `./client`). | Silent no-op for non-rows (`dsh-client-modules/lib/client.js:265-268`) |
| `dsh.client.external` | Declare real cross-bundle dependencies here. | Runtime require throws on an unresolved specifier |

**Do not** list a pure-core package (e.g. `dsh-client-ui-slots`) in `inject`: it has
no `./client` export and no `dsh.client` declaration, so `resolveMeta` returns null
and the entry does nothing.

### Patch file shape

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-usage-bar
      name: 'dsh-usage-bar'
```

Plugin config goes under a nested `config:` key. A key written beside `name:`
instead is silently ignored — the loader passes only the `config` sub-object to the
plugin.

---

## Node half

### Shape

```js
export const inject = ["webServer", "connection"];
export function apply(ctx) { /* ... */ }
```

- `inject` is for **hard** dependencies only. A missing hard dependency parks the
  fiber in `waiting` rather than failing.
- Optional capabilities are read with `ctx.get(name)` and an explicit absence check.
  Reading `ctx.foo` without declaring it is rejected by the guard.

### Side effects belong to the fiber

Every listener, timer, and subscription must be registered through `ctx.on` /
`ctx.effect` so unloading removes it.

```js
// WRONG: survives unload, keeps writing after the plugin is gone
let saveTimer = null;
saveTimer = setTimeout(() => persist(store), 2000);

// RIGHT: owned by the fiber
ctx.effect(() => () => { if (saveTimer !== null) clearTimeout(saveTimer); }, "…: timers");
```

This is asserted by `selftest-timers.mjs`: it drives the real `apply()` with a
stubbed timer table and fails if any created timer is still live after dispose.

### HTTP routes

```js
const rejected = (req, res) => {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.writeHead(rejection); res.end(); return true;
};

ctx.effect(() => ctx.webServer.register({
  kind: "exact",                       // (1)
  path: "/dsh-usage-bar/summary",
  async handler(req, res) {
    if (rejected(req, res)) return;     // (2)
    if (req.method !== "GET") { methodNotAllowed(res, "GET"); return; }  // (3)
    sendJson(res, 200, body);
  },
}), "…: summary route");
```

1. **`kind` is not optional in practice.** `register` sends anything that is not
   `"exact"` into the longest-prefix table (`dsh-host-webserver/lib/index.js:177`),
   so an omitted `kind` makes `/summary/anything` resolve to your handler.
2. **`requestRejection` is the trust boundary** for routes outside `/api`: it applies
   the Host/Origin fence (anti-DNS-rebinding) then browser authentication
   (`dsh-client-connection/lib/index.js:553-556`). The `/api` gateway applies it for
   you; a custom path does not get it for free.
3. Every handler checks its method.

**Never put a secret in a query string, and never serve one from an unauthenticated
route.** A GET with a side effect is also wrong: reset is POST with the secret in a
header.

---

## Session data

### Read logs through `ctx.sessionPersistence`

Do not construct paths or decode artifacts yourself. The service owns all of it:

```js
const persistence = ctx.get("sessionPersistence");
if (persistence === undefined) return;              // degrade, don't fail
for (const snap of await persistence.list()) {
  const handle = await persistence.open(snap.header.id, "read");
  const { events } = await handle.read();           // decoded event objects
  await handle.close();
}
```

Verified properties:

- `open(id, "read")` resolves by **id alone** — no cwd or project path needed
  (`dsh-session-persistence-jsonl/lib/index.js:3239-3251`).
- Current-generation selection (`session.v{N}.jsonl.zstd`, highest N) and v2→v3
  migration happen inside `readStoredLog` (`:2682-2693`).
- `read(offset, length)` takes **event indices**, not bytes, and returns parsed events
  (`:101-109`).

### Resolve the harness home correctly

Precedence is **explicit config > `$DSH_HOME` > `~/.dsh`**, and a blank
`$DSH_HOME` counts as unset (`dsh-home-paths/lib/index.js:73-76`). Hardcoding
`homedir()/.dsh` breaks on any machine that sets `$DSH_HOME` — including this one,
where the store would be written to a tree the harness never reads.

### Folding usage

The `tokenUsage` fold is the official semantics: `assistant/chunk` (type `usage`) is
an early sample, `assistant/message`'s `data.usage` **replaces** it for the same
attempt, and `llm/retry-started` closes the replacement slot so a retried attempt
adds. `src/index.js`'s `foldUsage` matches `tokenUsageProjectionDefinition`
(`dsh-token-meter/lib/types/usage-projection.js:86-119`) — do not "simplify" it.

### Accounting must be idempotent

**Accumulating deltas is a bug generator.** A session observed live and then again by
a backfill pass gets counted twice unless the two paths agree on what has been
counted. The rule this project settled on:

> A session owns one ledger entry that is a pure function of its event log; every
> displayed number is a sum over entries.

Recompute-and-replace, never add-into-a-running-total. See `selftest-idempotence.mjs`.

**`session/event` fires AFTER the event is committed**, so
`session.snapshotEvents()` already contains the event being delivered. Seeding a fold
from the snapshot and then folding the delivered event counts it twice; guard with a
sequence watermark (the official `session-projection` `advanceCell` does the same).

---

## Client half

### Form

- JSX-free: `React.createElement`. No imports — the bundle is a factory body whose
  `require` resolves seed words (`react`, `react/jsx-runtime`) and graph rows.
- `exports.inject = ["slots", "locale"]` and `exports.apply = apply`.

### Stylesheets

Tag the element so the module system attributes it:

```js
const selector = "style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]";
if (document.querySelector(selector) === null) {
  const tag = document.createElement("style");
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
```

An untagged `<style>` is claimed by whichever plugin materializes next
(`dsh-client-modules/lib/client.js:170-176`), so it can be removed by an unrelated
plugin's reload.

### Theme tokens

Use only tokens declared in `dsh-client-ui-theme`. Two traps hit this project:

- `--dsw-alias-text-accent` **does not exist** (0 declarations repo-wide). The accent
  token is `--dsw-alias-brand-primary`.
- `--dsw-hovercard-bg` is a *component-local* variable inside
  `dsh-client-ui-primitives/HoverCard.module.css`, not a theme token. Use
  `--dsw-alias-bg-layer-2` with `--dsw-elevation-prominent`.

`selftest-rail.mjs` asserts the injected CSS references only an allowlist of
verified-declared tokens.

### Slots

- Sidebar entry point: `sidebar.footer.action` (`kind: "list"`, `scope: "root"`).
  Prefer additive inner slots over replacing a whole region.
- Rail (collapsed sidebar) state comes from the framework's own
  `[data-sidebar-collapsed]` attribute on the app frame
  (`dsh-client-ui-layout/lib/client.js:282`), read via `closest(...)` — not from the
  slot's `wide` prop and not by measuring the pill.

---

## Measuring the live path

Two traps cost real time here. Both produce *plausible* numbers, which is what makes
them dangerous.

### Model `snapshotEvents()` as growing

`session/event` fires **after** the event is committed, so `snapshotEvents()` already
contains it. A benchmark fixture that returns a fixed full list therefore makes the
first delivery seed `observedSeq` to the maximum and every later event take the early
return — reporting ~0.0us/event for code that was doing real work. Drive the fixture
the way the harness does: append first, then deliver.

### Watch for per-event cost that scales with session shape

`flushSession` runs once per usage event. A deep clone of the per-day map there made
per-event cost grow with the number of days a session had spanned (5.8us at 2 days vs
29.7us at 365 days; 1.08s for 36,500 events). The ledger entry now shares the fold
state's `daily` map by reference — safe because both are plugin-owned and mutated only
by `foldApply`. Cloning is still correct on the **load** path, where isolation from
freshly parsed JSON matters.

**Rule:** before optimizing, ask whether the benchmark models the real call sequence.
After optimizing, assert the invariant the optimization could break — for reference
sharing that is `sum(daily) === totals` per entry
(`selftest-ledger-invariants.mjs`).

## Testing conventions

- **Test the real thing.** A test that re-implements the logic it claims to verify
  passes with the feature deleted. `selftest-reset.mjs` drives the actual registered
  route handlers; `selftest-integration.mjs` drives the real `apply()`.
- **Prove falsifiability for anything load-bearing.** Temporarily revert the fix and
  confirm the test fails for the stated reason. Done for: the idempotence invariant,
  the nonce gate, the trust fence, and timer ownership.
- Tests needing real session logs **skip** (not fail) when none are present, and take
  their path from `$DSH_HOME` — never a hardcoded home.
- **Assert invariants, not just outputs.** `selftest-ledger-invariants.mjs` checks
  `sum(daily) === totals` per ledger entry, which is the property any change to the
  storage sharing or fold would violate.
- **Exercise failure paths.** `selftest-persist.mjs` drives a genuinely unwritable
  store and asserts the plugin stays usable and reports once.