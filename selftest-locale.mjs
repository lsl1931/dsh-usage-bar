// Locale-registration lifecycle selftest.
//
// The client half registers two dictionary entries with the locale service.
// That service refuses a second registration of the same namespace + locale
// (dsh-client-locale/lib/client.js: "locale namespace ... already has locale ..."),
// so a bare register() call inside apply() breaks the whole client half as soon
// as the module is re-materialized: HMR revision, or disable -> enable in the
// Plugins page. The registration therefore has to be an effect, which is how
// the first-party plugins wire it (ui-sidebar: "dictionaries").
//
// This drives the real apply() through the built bundle with a locale stub that
// models the real refusal, and asserts the registration is repeatable.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const NS = "dsh-usage-bar";

// --- react stub: hooks are inert, render paths are not exercised here ----------
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
};

// --- minimal DOM: one style tag the plugin owns -------------------------------
const makeTag = () => ({
  dataset: {},
  textContent: "",
  getAttribute: () => null,
  setAttribute: () => {},
  remove() {},
});
const documentStub = {
  documentElement: {},
  querySelector: () => null,
  createElement: makeTag,
  head: { appendChild: (tag) => tag },
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
};
globalThis.fetch = () => Promise.reject(new Error("offline"));

// --- load the BUILT bundle through the ModuleLoader contract ------------------
const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "document", "ResizeObserver", "fetch", "MutationObserver", "require", "exports", "module", src)(
  globalThis.window, globalThis.document, globalThis.ResizeObserver, globalThis.fetch,
  globalThis.MutationObserver, (id) => (id === "react" ? react : require_(id)), {}, {},
);
const mod = globalThis.__factory((id) => (id === "react" ? react : require_(id)));

// --- a locale service that models the real duplicate refusal ------------------
const registered = new Set();
const locale = {
  register(ns, dicts) {
    for (const name of Object.keys(dicts)) {
      const key = ns + "/" + name;
      if (registered.has(key)) throw new Error('locale namespace "' + ns + '" already has locale "' + name + '"');
    }
    for (const name of Object.keys(dicts)) registered.add(ns + "/" + name);
    return () => {
      for (const name of Object.keys(dicts)) registered.delete(ns + "/" + name);
    };
  },
};

// --- cordis-like ctx: effect() runs now and remembers its disposer ------------
function makeCtx() {
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === "function") disposers.push(cleanup);
      return () => cleanup && cleanup();
    },
    locale,
    slots: { inject: (_key, fn) => fn(), register: () => () => {} },
  };
  return {
    ctx,
    dispose: () => {
      while (disposers.length > 0) disposers.pop()();
    },
  };
}

const expected = [NS + "/en", NS + "/zh"].sort();

// 1) first activation registers both dictionaries.
const first = makeCtx();
mod.apply(first.ctx);
assert.deepStrictEqual([...registered].sort(), expected, "apply() registers the zh and en dictionaries");

// 2) disposing the fiber releases them (the registration is owned by an effect).
first.dispose();
assert.strictEqual(registered.size, 0, "disposing the fiber must release its dictionaries");

// 3) a second activation - HMR revision, or disable -> enable - must not throw.
const second = makeCtx();
mod.apply(second.ctx);
assert.deepStrictEqual([...registered].sort(), expected, "a second apply() re-registers cleanly");

// 4) and it stays repeatable.
second.dispose();
const third = makeCtx();
mod.apply(third.ctx);
assert.deepStrictEqual([...registered].sort(), expected, "the registration is repeatable");

console.log("ALL PASS", JSON.stringify({ namespace: NS, registrations: registered.size }));
