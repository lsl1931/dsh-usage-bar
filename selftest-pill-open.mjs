// Popover-trigger selftest.
//
// Opening the panel is an explicit act. A hover path once sat on the pill
// (onMouseEnter -> a 400ms timer in a ref -> setOpen(true), onMouseLeave
// cancelling it): the sidebar footer is a hover hot zone, so passing the pointer
// over the pill expanded the panel, and the click that followed toggled it back
// shut. The trigger is now: the pill's own click, or Enter/Space while the pill
// itself is focused - nothing else may change `open`.
//
// This renders the real component with persistent hook slots, drives the event
// handlers the way React would, and asserts the popover only ever follows an
// explicit activation.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

// --- timer watchdog: no interaction may schedule work of its own ------------------
let timersCreated = 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { timersCreated += 1; return realSetTimeout(...args); };

// --- react stub: persistent state slots, real memo semantics ----------------------
const slots = [];
const memos = [];
let cursorState = 0;
let cursorMemo = 0;
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (init) => {
    const i = cursorState++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init;
    return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
  },
  useMemo: (fn, deps) => {
    const i = cursorMemo++;
    const prev = memos[i];
    if (prev && Array.isArray(deps) && prev.deps.length === deps.length && prev.deps.every((d, k) => Object.is(d, deps[k]))) {
      return prev.value;
    }
    const value = fn();
    memos[i] = { deps: Array.isArray(deps) ? [...deps] : null, value };
    return value;
  },
};

// --- minimal DOM/window stubs -----------------------------------------------------
const styleTags = [];
globalThis.document = {
  documentElement: {},
  querySelector: (sel) => (sel.includes("data-plugin-css") ? (styleTags[0] ?? null) : null),
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  head: { appendChild: (tag) => { styleTags.push(tag); return tag; } },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { globalThis.__factory = factory; } },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1920,
  innerHeight: 1152,
};
globalThis.fetch = () => Promise.reject(new Error("offline"));

// --- load the BUILT bundle and grab the registered component ----------------------
const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "document", "ResizeObserver", "fetch", "MutationObserver", "require", "exports", "module", src)(
  globalThis.window, globalThis.document, globalThis.ResizeObserver, globalThis.fetch,
  globalThis.MutationObserver, (id) => (id === "react" ? react : require_(id)), {}, {},
);
const mod = globalThis.__factory((id) => (id === "react" ? react : require_(id)));

let Comp = null;
mod.apply({
  effect: (fn) => { const r = fn(); return () => r && r(); },
  locale: { register() {} },
  slots: { inject: (_k, fn) => fn(), register: (_o, comp) => { Comp = comp; } },
});
assert.ok(Comp, "registered into sidebar.footer.action");

// --- render helpers ---------------------------------------------------------------
const summary = {
  current: {
    totals: { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 12000, cacheWriteTokens: 300 },
    billedInputTokens: 11500,
    totalTokens: 13800,
  },
  allTime: { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, billedInputTokens: 0, totalTokens: 0 },
  backfilledSessions: 0,
};
// Hook order: 0 data, 1 resetting, 2 open, 3 daily, 4 selected, 5 page, 6 tab,
// then useRailMode's own useState at slot 7, then panelPos at slot 8.
slots[0] = summary;
slots[1] = false;
slots[2] = false; // the popover starts closed
slots[3] = { "2026-10-01": [1000, 100, 4000, 0] };
slots[4] = null;
slots[5] = 0;
slots[6] = "cal";
slots[7] = false;

function render() {
  cursorState = 0;
  cursorMemo = 0;
  const el = Comp({});
  assert.strictEqual(typeof el.type, "function", "registration returns the pill element");
  return el.type(el.props);
}

function findAll(node, pred, out = []) {
  if (node == null || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}
const pillOf = (tree) => findAll(tree, (n) => /^dsh-usage-bar(\s|$)/.test(String(n.props?.className ?? "")))[0];
const panelOf = (tree) => findAll(tree, (n) => String(n.props?.className ?? "").startsWith("dsh-usage-panel"))[0];
const isOpen = () => panelOf(render()) !== undefined;

// --- 1. the pill carries exactly one trigger, and it is not the mouse --------------
const pill = pillOf(render());
assert.ok(pill, "the pill renders");
for (const handler of ["onMouseEnter", "onMouseLeave", "onMouseOver", "onPointerEnter", "onPointerLeave"]) {
  assert.strictEqual(pill.props[handler], undefined, "hover must not be wired to the popover: " + handler);
}
assert.strictEqual(typeof pill.props.onClick, "function", "the pill is click-activated");
assert.strictEqual(typeof pill.props.onKeyDown, "function", "the pill is keyboard-activatable");
assert.strictEqual(pill.props.tabIndex, 0, "the only trigger must be reachable by keyboard");
assert.strictEqual(pill.props.role, "button", "role stays button");
assert.strictEqual(pill.props["aria-expanded"], "false", "aria-expanded starts false");

// --- 2. click toggles, and nothing else does --------------------------------------
const click = { target: pill.props, currentTarget: pill.props, stopPropagation() {} };
assert.strictEqual(isOpen(), false, "the popover starts closed");
pill.props.onClick(click);
assert.strictEqual(isOpen(), true, "one click opens the popover");
assert.strictEqual(pillOf(render()).props["aria-expanded"], "true", "aria-expanded follows");
pillOf(render()).props.onClick(click);
assert.strictEqual(isOpen(), false, "a second click closes it");

// --- 3. keyboard activation on the pill itself ------------------------------------
const key = (k, fromPill = true) => {
  const currentTarget = pillOf(render()).props;
  let prevented = false;
  pillOf(render()).props.onKeyDown({
    key: k,
    target: fromPill ? currentTarget : { tagName: "BUTTON" }, // i.e. the nested 清零 button
    currentTarget,
    preventDefault() { prevented = true; },
  });
  return prevented;
};
assert.strictEqual(key("Enter"), false, "Enter toggles without needing preventDefault");
assert.strictEqual(isOpen(), true, "Enter opens the popover");
assert.strictEqual(key(" "), true, "Space toggles and is prevented (it would scroll the sidebar)");
assert.strictEqual(isOpen(), false, "Space closes the popover");

// A key pressed inside the nested 清零 button bubbles up here too: it belongs to
// that button, and must not be read as a panel toggle.
slots[2] = true;
key("Enter", false);
assert.strictEqual(isOpen(), true, "Enter inside the nested button must not toggle the panel");
slots[2] = false;

// --- 4. no interaction schedules work of its own ----------------------------------
assert.strictEqual(timersCreated, 0, "no timer is created by clicking, keying or rendering (the retired hover path was one)");

globalThis.setTimeout = realSetTimeout;
console.log("ALL PASS", JSON.stringify({ handlers: Object.keys(pill.props).sort(), timersCreated }));
