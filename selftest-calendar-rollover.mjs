// Calendar-window rollover selftest.
//
// The popover's 30-day window is a pure function of (page, local calendar day),
// but the memo that built it was keyed on `page` alone. `page` does not change
// while the sidebar sits open, so a page left open overnight kept YESTERDAY's
// window - range label "09.01 – 09.30", yesterday still carrying the today
// marker - while the detail pane (fed by the summary poll and the daily fetch)
// had already moved to the new day. The selected day then had no cell in the
// visible grid at all, and clicking ‹/› rebuilt the window around the stale day.
//
// This renders the real component with a memo-aware hook stub and a fake clock,
// rolls the clock over midnight, and re-renders the way the 10s poll does.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

// --- fake clock: bare new Date() is "now", everything else is untouched -----------
const RealDate = Date;
let now = new RealDate(2026, 8, 30, 23, 50, 0).getTime();
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(now);
    else super(...args);
  }
  static now() {
    return now;
  }
}
globalThis.Date = FakeDate;

// --- react stub with persistent state slots and real memo semantics ---------------
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
const documentStub = {
  documentElement: {},
  querySelector: (sel) => (sel.includes("data-plugin-css") ? (styleTags[0] ?? null) : null),
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  head: { appendChild: (tag) => { styleTags.push(tag); return tag; } },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = documentStub;
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
const ctx = {
  effect: (fn) => { const r = fn(); return () => r && r(); },
  locale: { register: () => {} },
  slots: { inject: (_k, fn) => fn(), register: (_opts, comp) => { Comp = comp; } },
};
mod.apply(ctx);
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
const buckets = (n) => [n, n, n * 4, 0];

// Hook order: 0 data, 1 resetting, 2 open, 3 daily, 4 selected, 5 page, 6 tab,
// then useRailMode's own useState at slot 7 (its effect does not run in this stub,
// so the value is seeded), then panelPos at slot 8.
slots[0] = summary;
slots[1] = false;
slots[2] = true; // the popover is open, as in the report
slots[3] = { "2026-09-29": buckets(1000), "2026-09-30": buckets(2000) };
slots[4] = null;
slots[5] = 0; // page 0 = the current window
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
const text = (node) =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join("")
      : (node?.children ?? []).map(text).join("");

const rangeLabel = (tree) => {
  const [range] = findAll(tree, (n) => n.props?.className === "dsh-usage-panel__range");
  assert.ok(range, "the calendar page renders a range label");
  return text(range).trim();
};
const dateHeader = (tree) => {
  const [d] = findAll(tree, (n) => n.props?.className === "dsh-usage-panel__date");
  assert.ok(d, "the panel renders a date header");
  return text(d).trim();
};
const cellTitles = (tree) => findAll(tree, (n) => String(n.props?.className ?? "").includes("dsh-usage-panel__cell")).map((n) => n.props.title);
const todayCell = (tree) => cellTitles(tree).find((t) => String(t).includes("（今天）"));

// --- before midnight: yesterday's window, which is correct while it is today -------
const before = render();
assert.strictEqual(rangeLabel(before), "09.01 – 09.30", "window ends on the current day");
assert.strictEqual(dateHeader(before), "2026-09-30 周三", "detail follows the latest day with data");
assert.ok(String(todayCell(before)).startsWith("2026-09-30"), "today marker sits on 09-30");

// --- midnight passes; the poll keeps re-rendering with no state change ------------
now = new RealDate(2026, 9, 1, 0, 5, 0).getTime();
// ...and the panel's daily fetch returns the new day, exactly as it does on open.
slots[3] = { ...slots[3], "2026-10-01": buckets(3000) };

const after = render();
assert.strictEqual(dateHeader(after), "2026-10-01 周四", "detail moved to the new day");
assert.strictEqual(rangeLabel(after), "09.02 – 10.01", "the 30-day window rolled over with the day");
assert.ok(String(todayCell(after)).startsWith("2026-10-01"), "today marker followed the day");

const titles = cellTitles(after);
assert.strictEqual(titles.length, 30, "30 day cells per page");
assert.ok(titles.some((t) => String(t).startsWith("2026-10-01")), "the selected day has a cell in the visible grid");

// Paging back must still land on the previous window relative to the rolled-over day.
const [back] = findAll(after, (n) => n.props?.className === "dsh-usage-panel__nav" && n.props.title.includes("上一页"));
assert.ok(back, "the previous-page button exists");
slots[5] = 1;
const paged = render();
assert.strictEqual(rangeLabel(paged), "08.03 – 09.01", "page 1 is the 30 days before the rolled-over window");
slots[5] = 0;

console.log("ALL PASS", JSON.stringify({ before: rangeLabel(before), after: rangeLabel(after), cells: titles.length }));
