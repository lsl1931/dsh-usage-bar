# UI Verification (browser gap closed as far as this sandbox allows)

## Why not a real browser

Chromium **cannot start under this sandbox**. Confirmed for both binaries:

| Binary | Failure |
|---|---|
| `chromium-1228/chrome.exe` | `crashpad_client_win.cc:421 OpenProcess: 拒绝访问 (0x5)`, then `platform_channel.cc:108 Check failed` (mojo IPC) |
| `chromium_headless_shell-1228/chrome-headless-shell.exe` | same mojo `platform_channel` denial |

Tried and rejected: `--no-sandbox`, `--single-process` (gets furthest — CDP opens, then the
socket is killed), `--headless=old`, `--in-process-gpu`, `--disable-crash-reporter`, `--disable-breakpad`.

`agent-browser` 0.26.0 is installed but hardcodes its runtime socket to `~/.agent-browser`,
which this sandbox denies. Found the undocumented `AGENT_BROWSER_SOCKET_DIR` in the binary
string table and pointed it inside the workspace — that fixed the socket error, but Chrome
still could not start for the mojo reason above.

## What was done instead

Real DOM, real React, real theme — everything except the paint step.

**Stack:** `jsdom` 29.1.1 + `react-dom` 18.3.1 (both present in the harness profile's
`node_modules`), driving **the bundle the running server actually serves**, against
**that same server's real responses**.

### 1. Real-DOM mount — PASS

```
served bundle: /plugins/??dsh-usage-bar/client.js&rev=b362b9b36f1fa602-44 (33901 bytes)
bundle inject: ["slots","locale"]
pill element found: true  class=dsh-usage-bar__root
style tags in <head>: 1
  data-plugin-css = "dsh-usage-bar/style.css" | bytes: 5824
theme tokens used: --dsw-alias-label-primary, --dsw-alias-interactive-bg-hover,
  --dsw-alias-label-secondary, --dsw-alias-brand-primary, --dsw-alias-label-tertiary,
  --dsw-alias-bg-layer-2, --dsw-elevation-prominent, --dsw-shadow-lv3
```

Rendered DOM (real React output, not a text stub):

```html
<div class="dsh-usage-bar__root">
  <div class="dsh-usage-bar" role="button" aria-expanded="false"
       title="本次统计：未缓存输入 5.10M · 缓存读 757.92M · 缓存写 0 · 输出 2.07M">
    <span class="dsh-usage-bar__item"><span>Σ</span>
      <span class="dsh-usage-bar__value">765.10M</span><span>tokens</span></span>
    <span class="dsh-usage-bar__spacer"></span>
    <span class="dsh-usage-bar__item"><span>缓存命中</span>
      <span class="dsh-usage-bar__hit">99.3%</span></span>
    <button class="dsh-usage-bar__reset" type="button"
            aria-label="清零本次统计显示">清零</button>
  </div>
</div>
```

This independently re-confirms AC10 (the `<style>` element carries
`data-plugin-css="dsh-usage-bar/style.css"`) in a genuine DOM, and AC11 (only declared
theme tokens are referenced).

### 2. Interaction — PASS

Driven through real DOM events with React's `act`:

| Behavior | Result |
|---|---|
| Rail mode (`[data-sidebar-collapsed]` on an ancestor) | pill collapses to `765M`; drops `tokens`, `缓存命中`, `清零` |
| Rail CSS keyed off the frame attribute | present in the injected stylesheet |
| Click the pill | panel mounts; `aria-expanded` flips to `true` |
| Panel content | 日历 / 历史累计 tabs; **30 day cells**; reset reachable in rail mode |
| Switch to 历史累计 | content changes to the all-time breakdown (`未缓存输入 / 缓存读 / 缓存写 / 输出`) |
| Click 清零 | `confirm()` prompted once, then **1 real POST /reset** issued |
| NaN / undefined | none anywhere |

The reset click initially reported a false failure: **jsdom implements no
`window.confirm()`**, so the handler correctly declined to act. Stubbed it and the real
POST fired — a test-environment gap, not a product bug.

### 3. Data integrity during the run — no silent skips

13 session directories exist, 10 appear in the ledger. The 3 absent ones are
**empty directories with no log artifact at all**:

```
MISSING  session-8710f908-…  logs=[] bytes=0
MISSING  session-9ed93f67-…  logs=[] bytes=0
MISSING  session-c77c6c9b-…  logs=[] bytes=0
```

The harness itself treats a never-materialized session as non-existent, so skipping them
is correct, not data loss. (The 11 "files" vs 10 "sessions" gap is one directory holding
both a v2 and a v3 generation.)

### 4. Pixel check — handed to you

Since pixels cannot be produced here, the render was exported as a self-contained file:

`.trellis/tasks/09-17-usage-bar-contract-alignment/ui-preview.html` (46 KB)

It inlines **the harness's own theme stylesheet**, extracted verbatim from
`dsh-client-ui-theme` (both light and `body[data-ds-dark-theme]` palettes, 29 KB), plus the
plugin's served stylesheet and the real rendered DOM, inside a mock sidebar footer with a
dark-mode toggle.

**Open it in your browser.** That is the pixel check: real CSS, real tokens, real markup.

## Still not verified (honest remainder)

- **Panel positioning offset.** jsdom has no layout engine — `getBoundingClientRect()`
  returns zeros and the panel renders at `width: 0px`. The rail fly-out geometry and the
  scroll-anchoring fix I added cannot be confirmed here; the preview shows the panel but
  not its measured offset.
- **Hover behavior** (`hoverTimer`, the open/close grace period).
- **`ResizeObserver`-driven repositioning** — stubbed, never exercised.
- **Real `dsh plugin add` install path** — pnpm cannot spawn under the sandbox, so the
  plugin was wired via a directory junction instead.

The first three need a browser that can launch; the last needs a normal terminal. Both are
one command for you:

```bash
# real browser, real install
dsh plugin --profile web add <this-repo>
dsh web
```
