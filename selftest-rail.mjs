// Rail-mode selftest: loads the BUILT client bundle through a stubbed
// ModuleLoader and asserts the collapsed-sidebar behaviour. Rail mode is
// detected from the framework's `[data-sidebar-collapsed]` frame attribute, so
// the DOM stub below implements the handful of APIs that path touches
// (closest + MutationObserver) and the test asserts the CSS is attribute-keyed
// rather than keyed off the slot's `wide` prop (whose delivery is not ours to
// guarantee).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

// --- minimal react stub: createElement records a tree, hooks are inert ---
let hookSlots = [];
let cursor = 0;
const states = [];
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: () => {},
  useLayoutEffect: (fn) => { try { fn(); } catch { /* DOM stub may not satisfy every effect */ } },
  useMemo: (fn) => fn(),
  // Every ref resolves to an element stub: the rail path reads
  // rootRef.current.closest(...) and panelRef.current.offsetHeight.
  useRef: () => ({ current: makeEl() }),
  useState: (v) => {
    const i = cursor++;
    if (!(i in hookSlots)) hookSlots[i] = typeof v === "function" ? v() : v;
    states[i] = hookSlots[i];
    return [hookSlots[i], (next) => { hookSlots[i] = typeof next === "function" ? next(hookSlots[i]) : next; }];
  },
};

// --- DOM stub: only what the rail-detection path uses ---
const makeEl = () => ({
  // Rail detection is `el.closest("[data-sidebar-collapsed]")`: return a match
  // only while the stub is in the collapsed state.
  closest: (sel) => (sel.includes("data-sidebar-collapsed") ? (CURRENT_COLLAPSED ? {} : null) : null),
  getBoundingClientRect: () => ({ left: 18, right: 54, top: 800, width: 36, height: 36 }),
  offsetHeight: 320,
  contains: () => false,
});
let CURRENT_COLLAPSED = false;
let observerCallback = null;
const documentStub = {
  documentElement: {},
  getElementById: () => null,
  createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.MutationObserver = class { constructor(cb) { observerCallback = cb } observe() {} disconnect() {} };
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory: f }) => { assert.strictEqual(id, "dsh-usage-bar"); factory = f; } },
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1920,
  innerHeight: 1152,
};
globalThis.document = documentStub;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.fetch = () => Promise.reject(new Error("offline"));

// --- load the bundle through the ModuleLoader contract ---
const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
let factory = null;
new Function("window", "document", "ResizeObserver", "fetch", "MutationObserver", "require", "exports", "module", src)(
  globalThis.window, globalThis.document, globalThis.ResizeObserver, globalThis.fetch,
  globalThis.MutationObserver, (id) => (id === "react" ? react : require_(id)), {}, {},
);
assert.ok(factory, "bundle registered a factory");
const mod = factory((id) => (id === "react" ? react : require_(id)));
assert.strictEqual(typeof mod.apply, "function", "exports apply");
assert.deepStrictEqual(mod.inject, ["slots", "locale"], "declares its inject list");

// --- capture the registered component ---
let Comp = null;
let css = null;
const ctx = {
  effect: (fn) => { const r = fn(); return () => r && r(); },
  locale: { register: () => {} },
  slots: { inject: (_k, fn) => fn(), register: (_opts, comp) => { Comp = comp; } },
};
mod.apply(ctx);
assert.ok(Comp, "registered into sidebar.footer.action");

// The stylesheet is injected through a <style> element; capture its text.
const styleCapture = { _t: "" };
documentStub.getElementById = () => null;
documentStub.createElement = () => ({ style: {}, set textContent(v) { css = v }, get textContent() { return css } });
mod.apply(ctx);
assert.ok(css && css.length > 100, "injects a stylesheet");

const collectText = (node) => {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  return (node.children ?? []).map(collectText).join(" ");
};

// The registration is `() => createElement(UsagePill)`, so Comp returns an
// element; unwrap it and call the inner component (that is where hooks run).
function renderPill(data, collapsed, open) {
  const summary = {
    totals: { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 12000, cacheWriteTokens: 300 },
    billedInputTokens: 11500,
    totalTokens: 13800,
    allTime: { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 0 },
    backfilledSessions: 0,
  };
  // Hook slot order in the component: 0 data, 1 resetting, 2 open, 3 daily,
  // 4 selected, 5 page, 6 tab, then useRailMode's own useState at slot 7
  // (the effect that sets it runs after the value is read, and there is no
  // re-render in this stub, so seed it directly).
  hookSlots = [data === null ? null : summary, false, !!open, null, 0, "cal", undefined, collapsed];
  cursor = 0;
  CURRENT_COLLAPSED = collapsed;
  const el = Comp({});
  assert.strictEqual(typeof el.type, "function", "registration returns the pill element");
  return el.type(el.props);
}

// First paint (no data) must not crash in either state.
assert.strictEqual(renderPill(null, false, false), null, "no data + expanded renders null");
assert.strictEqual(renderPill(null, true, false), null, "no data + collapsed renders null (no crash)");

const expandedText = collectText(renderPill("d", false, false)).replace(/\s+/g, " ").trim();
assert.ok(expandedText.includes("Σ") && expandedText.includes("tokens"), "expanded shows Σ…tokens");
assert.ok(expandedText.includes("缓存命中") && expandedText.includes("清零"), "expanded shows hit rate + reset");

// CSS assertions: the rail rule must be keyed off the framework attribute, and
// the base rule must not use the old flex-basis:100% that overflows the nowrap
// footer row in dsh 0.1.5.
assert.ok(css.includes("[data-sidebar-collapsed] .dsh-usage-bar__root"), "rail CSS keyed off the frame attribute");
assert.ok(/\[data-sidebar-collapsed\] \.dsh-usage-bar__root\{flex:none;width:36px/.test(css), "rail root is a fixed 36px non-flexing box");
assert.ok(!css.includes("flex:1 0 100%"), "no stale flex-basis:100% rule that overflows the nowrap row");

const railText = collectText(renderPill("d", true, false)).replace(/\s+/g, " ").trim();
assert.strictEqual(railText, "14k", "rail renders the compact total only");
assert.ok(!railText.includes("清零"), "rail pill drops the reset button (it moves into the panel)");
assert.ok(!railText.includes("tokens"), "rail drops the unit label");
assert.ok(!expandedText.includes("清零本次统计"), "expanded keeps 清零 only in the pill (no duplicate)");

// Rail + open: the panel must expose 清零本次统计 so the feature stays reachable.
const openText = collectText(renderPill("d", true, true)).replace(/\s+/g, " ").trim();
assert.ok(openText.includes("14k"), "rail pill number present while open");
assert.ok(openText.includes("清零本次统计"), "rail open panel exposes 清零本次统计");

console.log("ALL PASS", JSON.stringify({ expandedText, railText }));
