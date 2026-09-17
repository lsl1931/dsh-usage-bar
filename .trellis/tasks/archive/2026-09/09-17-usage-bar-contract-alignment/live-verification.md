# Live Verification — real `dsh web` run

Run against a real harness boot, not a stub. Isolated `$DSH_HOME` inside the
workspace (temp, since removed) so the user's own DSH Desktop session and store were
never touched — verified afterwards: no store created under the real home, bundle
list unchanged.

## What was run

```
DSH_HOME=<temp>/home  dsh --profile e2e --no-open --port 3181
```

Profile `e2e` initialized from the shipped `web` template, with the plugin wired in
via a directory junction (pnpm install is blocked by the sandbox) and 14 real session
log files copied in so the backfill had genuine data.

## Results

| Check | Result |
|---|---|
| Server boots with the plugin in the bundle stack | PASS — `dsh web: http://127.0.0.1:3181` |
| Plugin in the client boot manifest | PASS — `{"id":"dsh-usage-bar","url":"/plugins/??dsh-usage-bar/client.js&rev=…"}` |
| Client bundle served | PASS — 33,901 bytes, `window.__ModuleLoader__.load({...})`, id `dsh-usage-bar` |
| Served bundle contains the fixes | PASS — `dataset.pluginCss`, `--dsw-alias-brand-primary`, POST reset, nonce header |
| Served bundle has no stale tokens | PASS — no `--dsw-alias-text-accent`, no `--dsw-hovercard-bg` |
| Backfill reads real logs | PASS — 11 sessions, 676,439,370 total tokens |
| Store written under `$DSH_HOME` | PASS — `<temp>/storages/dsh-usage-bar/usage.json`, version 3 |
| Identity key format | PASS — ids are full `session-<uuid>` (not prefix-stripped) |

### Route contract, against the live server

| Request | Expected | Actual |
|---|---|---|
| `GET /dsh-usage-bar/summary` (no auth) | 401 | **401** |
| `GET /dsh-usage-bar/summary/anything` | not the handler | **404** |
| `GET /dsh-usage-bar/nonce` | 405 | **405** `method_not_allowed` |
| `POST /dsh-usage-bar/nonce` | 200 + nonce | **200** `{"nonce":"…"}` |
| `GET /dsh-usage-bar/reset` | 405 | **405** |
| `POST /dsh-usage-bar/reset` + wrong nonce | 403 | **403** `bad_nonce` |
| `POST /dsh-usage-bar/reset` + right nonce | 200 | **200** `{"ok":true}` |

The 404 on a suffixed path is the live proof that `kind:"exact"` works: before the
fix that request would have reached the summary handler.

### The original bug, against the live server

```
BEFORE reset  current = 4,353,307 uncached   allTime = 4,353,307
AFTER  reset  current = 0                    allTime = 4,353,307   (calendar unchanged)
--- process restart ---
AFTER  restart current = 0                   allTime = 4,353,307   (resetAt preserved)
```

Both halves of the original defect are gone in the real product: no re-inflation
across a restart, and no history replayed into the cleared period.

### Rendered UI

Chrome cannot launch under this sandbox (crashpad `OpenProcess` and mojo channel
creation are both denied; `--single-process` gets further but the CDP socket is then
killed). `agent-browser` is installed but hardcodes its socket directory to
`~/.agent-browser`, which the sandbox also denies.

So the closest available check was run instead: **the bundle the running server
actually serves** was fetched over HTTP and driven against **that same server's real
responses**, in a DOM-stubbed render. Rendered text from live data:

```
PILL (expanded) : Σ 676.44M tokens 缓存命中 99.4% 清零
PILL (rail)     : 676M
PANEL (open)    : 日历 | 历史累计 · 2026-09-17 周四 · 总量 207.20M · 缓存命中 99.1%
                  未缓存输入 1.81M · 缓存读 204.58M · 缓存写 0 · 输出 805.8k
                  ‹ 08.19 – 09.17 ›  calendar grid  ‹legend› 低 … 超高
```

Formatted correctly, no `NaN`/`undefined`, rail collapses to a compact count, both
tabs present, calendar populated from the two real days.

**Not verified:** actual pixel rendering, hover behavior, and popover positioning in a
real browser. Those need a browser that can launch; they are the residual gap.

## A finding about the hit-rate label

With `current` at zero (freshly reset), the pill correctly omits 缓存命中 — the label
is conditional on there being billable input or output. My first assertion assumed it
was always present and failed; the code was right and the test was wrong. Now asserted
as the condition rather than the label.

## Environment notes

- `pnpm` cannot spawn under the sandbox, so plugin install used a junction. This also
  means **the README's `dsh plugin add` install path was not exercised.**
- Two server restarts initially failed with `EADDRINUSE`: a killed job's shell still
  held the old process. Not a plugin issue.
- Cleanup left `_e2e` locked for a while because a killed job's shell had its cwd
  inside it; resolved by killing the job. Workspace is clean and all tests pass (9 at the
time of that run; the suite has since grown to 12).