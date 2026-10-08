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

A plugin-injected `<style>` is owned through the harness's `data-plugin` attribute,
**not** through `data-plugin-css`. Measured in
`dsh-client-modules/lib/client.js` (dsh 0.1.x, 884-line build; the line numbers this
project previously cited, 170-176, do not exist in it):

```js
// client.js:492-498 — run at the end of every materialize()
const claimStyles = (id) => {
  for (const el of document.querySelectorAll("style:not([data-plugin])")) el.setAttribute("data-plugin", id);
  const owned = [];  // returned, never read: removal is selector-based
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) owned.push(el.getAttribute("data-plugin-css") ?? id);
  return owned;
};

// client.js:190-197 — on replace (:367), prune (:821), reload (:312), rev change (:796)
function removeOwnedStyles(id) {
  for (const el of document.querySelectorAll("style[data-plugin]")) if (el.getAttribute("data-plugin") === id) el.remove();
}
```

So: **a tag with only `data-plugin-css` is invisible to `removeOwnedStyles` but wide
open to `claimStyles`.** The next plugin to materialize adopts it; when that plugin is
later replaced, pruned or rebuilt, *our* stylesheet is deleted with it. `materialize`
is memoized (`client.js:670-674`, `loadCache`), so this plugin's factory never runs
again and the tag never comes back — the pill and the popover keep rendering with **no
stylesheet at all** (grey beveled user-agent `<button>`s, no card background, calendar
cells sized by their own text and wrapped 8-to-a-row) until the page is reloaded. That
is why the report was "sometimes": it takes another plugin loading or reloading after
this one. `selftest-stylesheet.mjs` fails on the pre-fix shape and passes on this one.

```js
function ensureStyleTag() {
  let tag = document.querySelector(STYLE_SELECTOR);
  if (tag === null) {
    tag = document.createElement("style");
    tag.dataset.pluginCss = TAG_ID;   // findable: what the stylesheet IS
    document.head.appendChild(tag);
  }
  if (tag.dataset.plugin !== PLUGIN_ID) tag.dataset.plugin = PLUGIN_ID; // ownership: whose it is
  if (tag.textContent !== CSS) tag.textContent = CSS; // a tag outlives a module reload
  return tag;
}

let styleOwners = 0;
function mountStyleTag() {
  styleOwners += 1;
  ensureStyleTag();
  return () => {
    styleOwners -= 1;
    if (styleOwners > 0) return; // another instance is still mounted
    const existing = document.querySelector(STYLE_SELECTOR);
    if (existing) existing.remove();
  };
}
```

Set `PLUGIN_ID` to the module id this bundle registers in
`window.__ModuleLoader__.load({ id })` — that is the string `claimStyles` /
`removeOwnedStyles` compare against. The re-stamp also adopts a tag written by an older
build (which had no `data-plugin` and has therefore been claimed by somebody else).
The reference count is a second guard: dispose order between an old and a new fiber is
not ours to control, and a stale disposer must not strip a mounted instance's CSS.
`dsh-client-ui-theme` claims the same attribute on its own tag
(`dsh-client-ui-theme/lib/client.js:1181-1193`, `tag.dataset.plugin = PLUGIN_ID`).

Tags that belong to *other* plugins travel with this lesson too:
`dsh-session-namer` keys its tag by a bare DOM `id` and `dsh-xiaoba-brand` sets only
`data-plugin-css`, so both can be claimed and then deleted by an unrelated plugin's
reload (2026-10-01, unverified against their latest commits).

### Date-dependent derived state

`useMemo` keyed only on user state freezes across a date change: a page left open
overnight kept yesterday's 30-day calendar window (range label and "today" marker
included) while the polled detail moved to the new day, so the selected day had no
cell in the visible grid. Key the memo on the local day string as well — the summary
poll re-renders every 10 s, so no timer of our own is needed:

```js
const today = keyOf(new Date());
const pageData = useMemo(() => buildPage(page), [page, today]);
```

A mutable `Date.now()`-backed value is a legal memo key because it only changes when
the day does; anything that changes every render would just defeat the memo.

### Theme tokens

Use only tokens declared in `dsh-client-ui-theme`. Two traps hit this project:

- `--dsw-alias-text-accent` **does not exist** (0 declarations repo-wide).
- `--dsw-alias-brand-primary` exists but is **not an accent colour**: it resolves to
  `--dsw-static-neutral-bluish-1000` (`#0f1115`) in light and
  `--dsw-static-neutral-bluish-50` (`#f9fafb`) in dark, i.e. it is the
  *inverse* foreground used on a brand-coloured fill (hence its sibling
  `--dsw-alias-brand-primary-invert`). Using it as a heatmap base makes every
  tier render near-white and mutually indistinguishable.
- The real blue accent is `--dsw-alias-link` (`--dsw-static-deepseek-500` /
  `--dsw-static-deepseek-400`, `#4176e6` / `#679efe`).
  `--dsw-alias-button-info-fill` and `--dsw-alias-state-business-primary`
  hold the same pair if a stronger semantic fits.
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

#### Narrow-width fit ladder

The expanded sidebar is clamped to `[264, 420]` px
(`dsh-client-ui-layout/lib/client.js:38`), and the footer row gives the pill
`sidebarWidth - 24` px. The pill's full row (Σ + value + "tokens" + 缓存命中 +
pct + 清零) measures 265–272 px of min-content in the harness font, so at the
contract minimum the row overflows and `overflow:hidden` clips the **last**
child — the 清零 button. Fixed by making the pill its own query container
(`container-type:inline-size` on `.dsh-usage-bar`, never on `__root`: the popover
panel is a child of `__root`, and per spec layout containment makes the container
the containing block for fixed descendants — measured in Chrome 153 it does not
re-anchor them, but do not depend on that. The pill has no positioned
descendants, so the panel is safe either way) and degrading by priority: drop `tokens` below 272 px, drop
the 缓存命中 label below 217 px (below the narrowest reachable content box of
220 px, so the label survives every width the host can produce). Numbers and 清零 stay `flex:none` so the button
can never be the clipped child again. Thresholds are measured natural widths of
each tier, not guesses — see `selftest-rail.mjs`.

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