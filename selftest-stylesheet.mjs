// Stylesheet-ownership selftest.
//
// The plugin injects its CSS as a <style> tag, and the harness owns style-tag
// lifetime through the `data-plugin` attribute - measured in
// @deepseek-ai/dsh-client-modules/lib/client.js:
//
//   claimStyles(id)        (client.js:492-498, called from materialize)
//     every <style> WITHOUT data-plugin is stamped data-plugin = <plugin that
//     just materialized>.
//   removeOwnedStyles(id)  (client.js:190-197, called on replace/prune/reload)
//     removes every <style> whose data-plugin === id, exact match.
//
// A tag carrying only data-plugin-css is invisible to removeOwnedStyles but wide
// open to claimStyles: the next plugin to materialize adopts it, and the next time
// that plugin is replaced or pruned, our stylesheet is deleted with it. Because
// materialize is memoized (client.js:670-674), our factory never runs again, so the
// still-mounted plugin renders unstyled - grey beveled user-agent buttons, no card
// background, calendar cells wrapped 8-to-a-row - until the page is reloaded.
//
// This drives the real apply() and models the two harness functions above.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const PLUGIN_ID = "dsh-usage-bar";
const STYLE_ID = "dsh-usage-bar/style.css";

// --- react stub: hooks are inert, the pill's render path is not exercised here -----
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
};

// --- DOM stub: a LIVE list of style tags, attributes shared with dataset ----------
const styleTags = [];
const matches = (tag, sel) => {
  const m = /^style\[data-plugin-css=["'](.*)["']\]$/.exec(sel);
  return m !== null && tag.getAttribute("data-plugin-css") === m[1];
};
const makeTag = () => {
  const attrs = {};
  const tag = {
    textContent: "",
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value); },
    remove() {
      const i = styleTags.indexOf(tag);
      if (i >= 0) styleTags.splice(i, 1);
    },
  };
  Object.defineProperty(tag, "dataset", {
    value: {
      get plugin() { return attrs["data-plugin"] ?? undefined; },
      set plugin(v) { attrs["data-plugin"] = String(v); },
      get pluginCss() { return attrs["data-plugin-css"] ?? undefined; },
      set pluginCss(v) { attrs["data-plugin-css"] = String(v); },
    },
  });
  return tag;
};
const documentStub = {
  documentElement: {},
  querySelector: (sel) => styleTags.find((t) => matches(t, sel)) ?? null,
  createElement: makeTag,
  head: {
    appendChild(tag) {
      styleTags.push(tag);
      return tag;
    },
  },
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

// --- the harness's two style functions, modelled from the code read above ---------
const claimStyles = (id) => {
  for (const tag of styleTags) if (tag.getAttribute("data-plugin") === null) tag.setAttribute("data-plugin", id);
  return styleTags.filter((t) => t.getAttribute("data-plugin") === id).map((t) => t.getAttribute("data-plugin-css") ?? id);
};
const removeOwnedStyles = (id) => {
  for (const tag of [...styleTags]) if (tag.getAttribute("data-plugin") === id) tag.remove();
};

// --- load the BUILT bundle through the ModuleLoader contract ----------------------
const src = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "document", "ResizeObserver", "fetch", "MutationObserver", "require", "exports", "module", src)(
  globalThis.window, globalThis.document, globalThis.ResizeObserver, globalThis.fetch,
  globalThis.MutationObserver, (id) => (id === "react" ? react : require_(id)), {}, {},
);
const mod = globalThis.__factory((id) => (id === "react" ? react : require_(id)));

// --- a cordis-like ctx: effect() runs the callback now, returns its disposer ------
const instances = [];
function makeCtx() {
  const disposers = [];
  const ctx = {
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === "function") disposers.push(cleanup);
      return cleanup;
    },
    locale: { register: () => {} },
    slots: { inject: (_k, fn) => fn(), register: () => {} },
  };
  instances.push({ ctx, dispose: () => disposers.forEach((d) => d()) });
  return ctx;
}

// 1) first load: one tag, both attributes, carrying the CSS.
mod.apply(makeCtx());
assert.strictEqual(styleTags.length, 1, "first apply injects exactly one stylesheet");
assert.strictEqual(styleTags[0].getAttribute("data-plugin-css"), STYLE_ID, "tag carries the data-plugin-css attribution");
assert.strictEqual(styleTags[0].getAttribute("data-plugin"), PLUGIN_ID, "tag claims ownership with data-plugin");
const css = styleTags[0].textContent;
assert.ok(typeof css === "string" && css.length > 100, "tag holds the stylesheet text");

// 2) an OLDER build's tag (data-plugin-css only) must be adopted, not duplicated.
styleTags[0].setAttribute("data-plugin", "");
styleTags[0].dataset.plugin = undefined;
styleTags[0].setAttribute("data-plugin", "some-other-plugin");
mod.apply(makeCtx());
assert.strictEqual(styleTags.length, 1, "an existing tag is reused, not duplicated");
assert.strictEqual(styleTags[0].getAttribute("data-plugin"), PLUGIN_ID, "a tag claimed by another plugin is taken back");

// 3) another plugin materializes: the harness sweeps untagged styles. Ours is
//    tagged, so it must not be adopted by that plugin.
claimStyles("some-other-plugin");
assert.strictEqual(styleTags[0].getAttribute("data-plugin"), PLUGIN_ID, "the sweep leaves our tag alone");

// 4) ...and that other plugin is then replaced/pruned: its styles go, ours stay.
removeOwnedStyles("some-other-plugin");
assert.strictEqual(styleTags.length, 1, "another plugin's reload must not delete our stylesheet");
assert.strictEqual(styleTags[0].getAttribute("data-plugin"), PLUGIN_ID, "ours is still ours");

// 5) a stale build's CSS must not survive a reload.
styleTags[0].textContent = ".stale{}";
mod.apply(makeCtx());
assert.strictEqual(styleTags[0].textContent, css, "re-apply restores the current build's CSS");

// 6) dispose order is not ours to control: an older fiber going away must not strip
//    the stylesheet from a still-mounted instance.
instances[0].dispose();
assert.strictEqual(styleTags.length, 1, "disposing an older instance keeps the mounted instance's stylesheet");

// 7) this plugin's own replace path: the harness drops our styles, then imports the
//    new module, whose apply() must put them back.
removeOwnedStyles(PLUGIN_ID);
assert.strictEqual(styleTags.length, 0, "our own replace removes the stylesheet");
mod.apply(makeCtx());
assert.strictEqual(styleTags.length, 1, "the reloaded module re-injects the stylesheet");

// 8) last instance out removes the tag, so an unloaded plugin leaves no CSS behind.
const before = instances.length;
for (const instance of instances) instance.dispose();
assert.strictEqual(styleTags.length, 0, "the last dispose removes the stylesheet");
instances[before - 1].dispose(); // that fiber is already gone: must stay a no-op
assert.strictEqual(styleTags.length, 0, "an extra dispose is harmless");

console.log("ALL PASS", JSON.stringify({ plugin: PLUGIN_ID, css: css.length, tags: styleTags.length }));
