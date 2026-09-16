window.__ModuleLoader__.load({
	id: "dsh-usage-bar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// dsh-usage-bar client half: a usage pill pinned above the sidebar Settings
// row via the official `sidebar.footer.action` list slot, plus a popover with
// a calendar-style per-day heatmap: 30 days per page, ‹› paging, 4 usage tiers
// (low→ultra, light→dark), click a day for its usage + cache-hit details.
// The pill can toggle between "本次统计" (current accounting period, affected
// by 清零) and "历史累计" (all-time sum of the daily buckets, never reset).
// Collapsed sidebar (rail, ~36px): the panel keeps its own minimum width and
// flies out to the right of the pill, and the pill itself drops its labels
// down to the bare total instead of showing clipped fragments.
// Written JSX-free (React.createElement) and in CJS export form so no build
// toolchain is required: the bundle is this file wrapped in the factory-form
// CJS the dsh client-modules system consumes (window.__ModuleLoader__.load).
const { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } = require("react");

const NS = "dsh-usage-bar";
const BASE = "/dsh-usage-bar";

// The per-launch reset nonce is issued by the server in the summary response;
// the client echoes it on the reset GET so the reset can't be replayed by a
// stray cache/prefetch. Kept in module state across pill instances.
let sharedNonce = null;

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

// The rail gives the pill ~36px, so the number is rounded to at most 4
// characters ("14k", "999M", "1B") — the 6-char "24.05M" is what used to
// overflow and render as a clipped fragment.
const formatTokensShort = (n) =>
  !Number.isFinite(n) || n <= 0
    ? "0"
    : n >= 1e9
      ? Math.round(n / 1e9) + "B"
      : n >= 1e6
        ? Math.round(n / 1e6) + "M"
        : n >= 1e3
          ? Math.round(n / 1e3) + "k"
          : String(Math.round(n));

// Official cache-hit formula (dsh-client-ui-chat cacheHitPercent):
//   cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)
function cacheHitPercent(t) {
  const denom = t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (denom <= 0) return null;
  return (t.cacheReadTokens / denom) * 100;
}

function fetchSummary() {
  return fetch(BASE + "/summary", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : Promise.reject()))
    .then((json) => {
      if (typeof json.resetNonce === "string") sharedNonce = json.resetNonce;
      return json;
    });
}

function fetchDaily() {
  return fetch(BASE + "/daily", { cache: "no-store" }).then((res) => (res.ok ? res.json() : Promise.reject()));
}

function dayTotal(arr) {
  return arr ? arr[0] + arr[1] + arr[2] + arr[3] : 0;
}

const pad2 = (n) => String(n).padStart(2, "0");
function keyOf(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function shortOf(d) {
  return pad2(d.getMonth() + 1) + "." + pad2(d.getDate());
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function weekdayOf(key) {
  try {
    const [y, m, d] = key.split("-").map(Number);
    return WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()] ?? "";
  } catch {
    return "";
  }
}

// One calendar page: 30 days ending 30*page days ago, aligned to weekday
// columns (Sunday first), padded with blanks at both ends.
function buildPage(page) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const pageEnd = new Date(end);
  pageEnd.setDate(end.getDate() - 30 * page);
  const pageStart = new Date(pageEnd);
  pageStart.setDate(pageEnd.getDate() - 29);
  const leading = pageStart.getDay();
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(pageStart);
    d.setDate(pageStart.getDate() + i);
    days.push({ key: keyOf(d), dom: d.getDate(), future: d > end, today: d.getTime() === end.getTime() });
  }
  const trailing = (7 - ((leading + days.length) % 7)) % 7;
  const label =
    pageStart.getFullYear() === pageEnd.getFullYear() ? shortOf(pageStart) + " – " + shortOf(pageEnd) : keyOf(pageStart).slice(0, 7) + " – " + shortOf(pageEnd);
  return { leading, days, trailing, label };
}

const TIER_ALPHA = [0, 28, 52, 78, 100]; // background color-mix %, index = tier

// The collapsed sidebar hands this slot ~36px, far less than the pill's
// min-content width, and the footer row there is `width:auto` +
// justify-content:center — so an over-wide pill spills out BOTH sides and
// root.left goes negative, which is what shoves the popover off-screen (a
// flex-basis:100% pill did exactly that in dsh 0.1.5's nowrap row). Rail mode is
// therefore detected from the framework's own `data-sidebar-collapsed` attribute
// on the app frame (a real ancestor of this slot), NOT from the slot's `wide`
// prop or the pill's own width: the prop's delivery depends on which component
// renders the slot, and measuring the pill is self-influenced (rail styling
// narrows it, which would latch it narrow forever).
const RAIL_ATTR = "data-sidebar-collapsed";
const PANEL_MIN_W = 268;

const STYLE_ID = "dsh-usage-bar-style";

function railOf(el) {
  return !!(el && el.closest && el.closest("[" + RAIL_ATTR + "]"));
}

// True while an ancestor frame carries RAIL_ATTR; tracks collapse/expand live.
function useRailMode(ref, active) {
  const [rail, setRail] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setRail(railOf(el));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [RAIL_ATTR], subtree: true });
    return () => mo.disconnect();
  }, [active]);
  return rail;
}

function UsagePill() {
  const [data, setData] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState(null); // { "YYYY-MM-DD": [u,o,r,w] }
  const [selected, setSelected] = useState(null); // "YYYY-MM-DD"
  const [page, setPage] = useState(0); // 0 = current 30-day window
  const [tab, setTab] = useState("cal"); // panel view: "cal" = 日历 | "all" = 历史累计
  const resettingRef = useRef(false);
  const rootRef = useRef(null);
  const hoverTimer = useRef(null);
  const rail = useRailMode(rootRef, !!data);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let delay = 2000;
    const loop = async () => {
      if (cancelled) return;
      try {
        const json = await fetchSummary();
        if (!cancelled) setData(json);
      } catch {
        // host unreachable: keep last value
      }
      if (cancelled) return;
      timer = setTimeout(loop, delay);
      delay = 10000;
    };
    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Open: fetch daily buckets; close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchDaily()
      .then((json) => {
        if (!cancelled) setDaily(json.daily ?? {});
      })
      .catch(() => {});
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fixed positioning anchored to the pill, computed from the MEASURED panel
  // height (no translate percentages: those mis-anchor when the panel's
  // height changes between paints). Width follows the pill but never drops
  // below PANEL_MIN_W, so the collapsed rail (≈36px) still gets a readable
  // panel: that one flies out to the RIGHT of the rail. Both axes are clamped
  // into the viewport, and the width is clamped BEFORE the left so a shrinking
  // window can never push the right edge off-screen.
  const panelRef = useRef(null);
  const [panelPos, setPanelPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const compute = () => {
      const root = rootRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!root || !panel) return;
      const height = panel.offsetHeight;
      const avail = window.innerWidth - 16;
      const width = Math.min(rail ? PANEL_MIN_W : root.width, avail);
      const anchor = rail ? root.right + 8 : root.left;
      const left = Math.min(Math.max(8, anchor), Math.max(8, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(root.top - 6 - height, window.innerHeight - height - 8));
      setPanelPos((prev) =>
        prev && prev.top === top && prev.left === left && prev.width === width ? prev : { left, top, width },
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [open, rail]);

  const pageData = useMemo(() => buildPage(page), [page, open]);
  const maxDay = useMemo(() => {
    let max = 0;
    if (daily) for (const arr of Object.values(daily)) max = Math.max(max, dayTotal(arr));
    return max;
  }, [daily]);

  const tierOf = (key) => {
    const total = daily ? dayTotal(daily[key]) : 0;
    if (!total || maxDay <= 0) return 0;
    const ratio = total / maxDay;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  const tierBg = (tier) =>
    tier === 0
      ? "var(--dsw-alias-interactive-bg-hover)"
      : "color-mix(in srgb, var(--dsw-alias-text-accent, #4c9aff) " + TIER_ALPHA[tier] + "%, var(--dsw-alias-interactive-bg-hover))";

  const handleReset = async (e) => {
    e.stopPropagation();
    if (resettingRef.current) return;
    if (!window.confirm("清零「本次统计」的总量显示？\n仅影响本次周期数字；历史累计与日历热力图保留。")) return;
    resettingRef.current = true;
    setResetting(true);
    try {
      const nonce = sharedNonce ?? "";
      const res = await fetch(BASE + "/reset?n=" + encodeURIComponent(nonce), { cache: "no-store" });
      if (!res.ok) throw new Error("reset failed");
      const json = await fetchSummary();
      setData(json);
    } catch {
      // keep last display if reset/RPC failed
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  };

  const toggle = () => setOpen((v) => !v);
  const hoverOpen = () => {
    if (hoverTimer.current) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setOpen(true);
    }, 400);
  };
  const hoverCancel = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  // default selection: latest day that has data (usually today)
  const effectiveSelected = useMemo(() => {
    if (selected) return selected;
    if (!daily) return null;
    const keys = Object.keys(daily).sort();
    return keys.length ? keys[keys.length - 1] : null;
  }, [selected, daily, open]);

  const sel = effectiveSelected && daily ? daily[effectiveSelected] : null;
  const selBuckets = sel ? { uncachedInputTokens: sel[0], outputTokens: sel[1], cacheReadTokens: sel[2], cacheWriteTokens: sel[3] } : null;
  const selHit = selBuckets ? cacheHitPercent(selBuckets) : null;
  const selTotal = sel ? dayTotal(sel) : 0;

  if (!data || !data.totals) return null;

  // All-time view data (server-provided sum of every daily bucket).
  const allTime = data.allTime && data.allTime.totals ? data.allTime : null;
  const allTimeHit = allTime ? cacheHitPercent(allTime.totals) : null;
  const title =
    "本次统计：" +
    "未缓存输入 " + formatTokens(data.totals.uncachedInputTokens) +
    " · 缓存读 " + formatTokens(data.totals.cacheReadTokens) +
    " · 缓存写 " + formatTokens(data.totals.cacheWriteTokens) +
    " · 输出 " + formatTokens(data.totals.outputTokens);

  const cellEls = [];
  for (let i = 0; i < pageData.leading; i++) cellEls.push(createElement("span", { key: "lead" + i, className: "dsh-usage-panel__blank" }));
  for (const day of pageData.days) {
    const tier = tierOf(day.key);
    const total = daily ? dayTotal(daily[day.key]) : 0;
    cellEls.push(
      createElement(
        "button",
        {
          key: day.key,
          type: "button",
          className:
            "dsh-usage-panel__cell" +
            (day.future ? " dsh-usage-panel__cell--future" : "") +
            (day.today ? " dsh-usage-panel__cell--today" : "") +
            (effectiveSelected === day.key ? " dsh-usage-panel__cell--sel" : ""),
          style: { background: tierBg(tier) },
          disabled: day.future,
          title:
            day.key +
            (total > 0 ? " · " + formatTokens(total) + " tokens" : " · 无记录") +
            (day.today ? "（今天）" : ""),
          onClick: () => setSelected(day.key),
        },
        String(day.dom),
      ),
    );
  }
  for (let i = 0; i < pageData.trailing; i++) cellEls.push(createElement("span", { key: "trail" + i, className: "dsh-usage-panel__blank" }));

  return createElement(
    "div",
    { className: "dsh-usage-bar__root", ref: rootRef },
    createElement(
      "div",
      {
        className: "dsh-usage-bar" + (open ? " dsh-usage-bar--open" : ""),
        title,
        onClick: toggle,
        onMouseEnter: hoverOpen,
        onMouseLeave: hoverCancel,
        role: "button",
        "aria-expanded": open ? "true" : "false",
      },
      rail
        ? createElement("span", { className: "dsh-usage-bar__sym" }, formatTokensShort(data.totalTokens ?? 0))
        : [
            createElement(
              "span",
              { key: "v", className: "dsh-usage-bar__item" },
              createElement("span", null, "Σ"),
              createElement("span", { className: "dsh-usage-bar__value" }, formatTokens(data.totalTokens ?? 0)),
              createElement("span", null, "tokens"),
            ),
            createElement("span", { key: "sp", className: "dsh-usage-bar__spacer" }),
            data.billedInputTokens + data.totals.outputTokens > 0
              ? createElement(
                  "span",
                  { key: "hit", className: "dsh-usage-bar__item" },
                  createElement("span", null, "缓存命中"),
                  createElement("span", { className: "dsh-usage-bar__hit" }, (cacheHitPercent(data.totals) ?? 0).toFixed(1) + "%"),
                )
              : null,
            createElement(
              "button",
              {
                key: "reset",
                className: "dsh-usage-bar__reset",
                type: "button",
                title: "清零「本次统计」显示（历史累计与日历保留）",
                "aria-label": "清零本次统计显示",
                disabled: resetting,
                onClick: handleReset,
              },
              resetting ? "…" : "清零",
            ),
          ],
    ),
    open
      ? createElement(
          "div",
          {
            className: "dsh-usage-panel",
            ref: panelRef,
            style: {
              position: "fixed",
              left: (panelPos ? panelPos.left : 0) + "px",
              top: (panelPos ? panelPos.top : 0) + "px",
              width: (panelPos ? panelPos.width : 0) + "px",
              visibility: panelPos ? "visible" : "hidden",
            },
            onClick: (e) => e.stopPropagation(),
          },
          // view tabs: calendar (per-day) vs all-time totals
          createElement(
            "div",
            { className: "dsh-usage-panel__tabs" },
            createElement(
              "button",
              { className: "dsh-usage-panel__tab" + (tab === "cal" ? " dsh-usage-panel__tab--on" : ""), type: "button", onClick: () => setTab("cal") },
              "日历",
            ),
            createElement(
              "button",
              {
                className: "dsh-usage-panel__tab" + (tab === "all" ? " dsh-usage-panel__tab--on" : ""),
                type: "button",
                title: "全部历史数据（不受清零影响）",
                onClick: () => setTab("all"),
              },
              "历史累计",
            ),
          ),
          tab === "cal"
            ? createElement(
                "div",
                null,
                // selected-day details: date → hero → separator → bucket rows
                createElement(
                  "div",
                  { className: "dsh-usage-panel__detail" },
                  effectiveSelected && sel
                    ? createElement(
                        "div",
                        null,
                        createElement("div", { className: "dsh-usage-panel__date" }, effectiveSelected, " ", weekdayOf(effectiveSelected)),
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__hero" },
                          createElement("span", null, "总量 ", createElement("b", null, formatTokens(selTotal))),
                          createElement("span", null, "缓存命中 ", createElement("b", null, selHit !== null ? selHit.toFixed(1) + "%" : "—")),
                        ),
                        createElement("div", { className: "dsh-usage-panel__sep" }),
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__rows" },
                          createElement(
                            "div",
                            { className: "dsh-usage-panel__row" },
                            createElement("span", { className: "lbl" }, "未缓存输入"),
                            createElement("span", { className: "val" }, formatTokens(selBuckets.uncachedInputTokens)),
                          ),
                          createElement(
                            "div",
                            { className: "dsh-usage-panel__row" },
                            createElement("span", { className: "lbl" }, "缓存读"),
                            createElement("span", { className: "val" }, formatTokens(selBuckets.cacheReadTokens)),
                          ),
                          createElement(
                            "div",
                            { className: "dsh-usage-panel__row" },
                            createElement("span", { className: "lbl" }, "缓存写"),
                            createElement("span", { className: "val" }, formatTokens(selBuckets.cacheWriteTokens)),
                          ),
                          createElement(
                            "div",
                            { className: "dsh-usage-panel__row" },
                            createElement("span", { className: "lbl" }, "输出"),
                            createElement("span", { className: "val" }, formatTokens(selBuckets.outputTokens)),
                          ),
                        ),
                      )
                    : createElement("div", { className: "dsh-usage-panel__detail-title" }, daily ? "近 30 天暂无数据" : "加载中…"),
                ),
                // pager + weekday header + calendar grid
                createElement(
                  "div",
                  { className: "dsh-usage-panel__pager" },
                  createElement(
                    "button",
                    { className: "dsh-usage-panel__nav", type: "button", title: "上一页（更早 30 天）", onClick: () => setPage((p) => p + 1) },
                    "‹",
                  ),
                  createElement("span", { className: "dsh-usage-panel__range" }, pageData.label),
                  createElement(
                    "button",
                    {
                      className: "dsh-usage-panel__nav",
                      type: "button",
                      title: "下一页（更近 30 天）",
                      disabled: page === 0,
                      onClick: () => setPage((p) => Math.max(0, p - 1)),
                    },
                    "›",
                  ),
                ),
                createElement(
                  "div",
                  { className: "dsh-usage-panel__cal" },
                  ...WEEKDAYS.map((w, i) =>
                    createElement("span", { key: "w" + i, className: "dsh-usage-panel__wd" + (i === 0 || i === 6 ? " dsh-usage-panel__wd--end" : "") }, w),
                  ),
                  ...cellEls,
                ),
                // legend
                createElement(
                  "div",
                  { className: "dsh-usage-panel__legend" },
                  createElement("span", null, "低"),
                  ...[1, 2, 3, 4].map((t) =>
                    createElement("span", { key: t, className: "dsh-usage-panel__swatch", style: { background: tierBg(t) } }),
                  ),
                  createElement("span", null, "超高"),
                  createElement("span", { className: "dsh-usage-panel__hint" }, "按当日峰值分档"),
                ),
              )
            : // all-time totals card
              createElement(
                "div",
                null,
                allTime
                  ? createElement(
                      "div",
                      { className: "dsh-usage-panel__detail" },
                      createElement("div", { className: "dsh-usage-panel__date" }, "历史累计"),
                      createElement(
                        "div",
                        { className: "dsh-usage-panel__hero" },
                        createElement("span", null, "总量 ", createElement("b", null, formatTokens(allTime.totalTokens))),
                        createElement("span", null, "缓存命中 ", createElement("b", null, allTimeHit !== null ? allTimeHit.toFixed(1) + "%" : "—")),
                      ),
                      createElement("div", { className: "dsh-usage-panel__sep" }),
                      createElement(
                        "div",
                        { className: "dsh-usage-panel__rows" },
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__row" },
                          createElement("span", { className: "lbl" }, "未缓存输入"),
                          createElement("span", { className: "val" }, formatTokens(allTime.totals.uncachedInputTokens)),
                        ),
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__row" },
                          createElement("span", { className: "lbl" }, "缓存读"),
                          createElement("span", { className: "val" }, formatTokens(allTime.totals.cacheReadTokens)),
                        ),
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__row" },
                          createElement("span", { className: "lbl" }, "缓存写"),
                          createElement("span", { className: "val" }, formatTokens(allTime.totals.cacheWriteTokens)),
                        ),
                        createElement(
                          "div",
                          { className: "dsh-usage-panel__row" },
                          createElement("span", { className: "lbl" }, "输出"),
                          createElement("span", { className: "val" }, formatTokens(allTime.totals.outputTokens)),
                        ),
                      ),
                      createElement(
                        "div",
                        { className: "dsh-usage-panel__alltime" },
                        "覆盖 " + (daily ? Object.keys(daily).length : 0) + " 天 · 历史会话 " + (data.backfilledSessions ?? 0) + " 个 · 不受清零影响",
                      ),
                    )
                  : createElement("div", { className: "dsh-usage-panel__detail-title" }, "加载中…"),
              ),
          // Rail mode leaves no room for 清零 in the pill, so it lives here —
          // the panel is the only surface left in that state.
          rail
            ? createElement(
                "div",
                { className: "dsh-usage-panel__actions" },
                createElement(
                  "button",
                  { className: "dsh-usage-panel__action", type: "button", disabled: resetting, onClick: handleReset },
                  resetting ? "…" : "清零本次统计",
                ),
              )
            : null,
        )
      : null,
  );
}

const inject = ["slots", "locale"];

function apply(ctx) {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    if (document.getElementById(STYLE_ID) === null) {
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    return () => {
      const existing = document.getElementById(STYLE_ID);
      if (existing) existing.remove();
    };
  }, "dsh-usage-bar: stylesheet");

  ctx.locale?.register?.(NS, {
    zh: { title: "Token 用量" },
    en: { title: "Token usage" },
  });

  ctx.slots.inject("sidebar.footer.action", () => {
    return ctx.slots.register(
      { name: "sidebar.footer.action", id: "dsh-usage-bar", order: 0, locale: NS },
      () => createElement(UsagePill),
    );
  });
}

exports.inject = inject;
exports.apply = apply;

const CSS =
  ".dsh-usage-bar__root{position:relative;flex:1 1 auto;width:100%;min-width:0;max-width:100%;box-sizing:border-box}" +
  // Rail geometry is declarative: it hangs off the framework's own
  // [data-sidebar-collapsed] frame attribute, so it is right from the FIRST
  // paint (no waiting on JS/observer) and cannot overflow the 36px rail the way
  // a flex-basis:100% rule does in 0.1.5's nowrap footer row.
  "[" + RAIL_ATTR + "] .dsh-usage-bar__root{flex:none;width:36px;max-width:100%}" +
  "[" + RAIL_ATTR + "] .dsh-usage-bar{justify-content:center;padding:0;height:36px;margin-bottom:0;border-radius:10px}" +
  ".dsh-usage-bar__sym{font-size:11px;line-height:1;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}" +
  ".dsh-usage-bar{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;margin:0 0 4px;" +
  "border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);" +
  "font-size:12px;line-height:16px;overflow:hidden;user-select:none;cursor:pointer}" +
  ".dsh-usage-bar:hover{background:rgba(128,128,140,.18)}" +
  ".dsh-usage-bar .dsh-usage-bar__item{display:flex;align-items:center;gap:4px;white-space:nowrap;flex:none}" +
  ".dsh-usage-bar .dsh-usage-bar__spacer{flex:1;min-width:4px}" +
  ".dsh-usage-bar .dsh-usage-bar__value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}" +
  ".dsh-usage-bar .dsh-usage-bar__hit{color:var(--dsw-alias-text-accent,#4c9aff);font-variant-numeric:tabular-nums}" +
  ".dsh-usage-bar__reset{cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;" +
  "height:18px;min-width:18px;padding:0 5px;border:none;border-radius:8px;background:0 0;" +
  "color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:1;transition:background .12s ease}" +
  ".dsh-usage-bar__reset:hover{background:rgba(128,128,140,.25);color:var(--dsw-alias-label-primary)}" +
  ".dsh-usage-bar__reset:disabled{opacity:.5;cursor:default}" +
  ".dsh-usage-panel{z-index:60;box-sizing:border-box;padding:10px 12px;border-radius:14px;background:var(--dsw-hovercard-bg,var(--dsw-alias-bg-layer-2,#2C2C2E));" +
  "box-shadow:var(--dsw-shadow-lv3,var(--dsw-elevation-prominent));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5}" +
  ".dsh-usage-panel__tabs{display:flex;gap:4px;margin-bottom:8px;background:rgba(128,128,140,.12);border-radius:9px;padding:2px}" +
  ".dsh-usage-panel__tab{flex:1;cursor:pointer;height:24px;border:none;border-radius:7px;background:0 0;" +
  "color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1}" +
  ".dsh-usage-panel__tab:hover{color:var(--dsw-alias-label-primary)}" +
  ".dsh-usage-panel__tab--on{background:rgba(128,128,140,.28);color:var(--dsw-alias-label-primary)}" +
  ".dsh-usage-panel__detail{margin-bottom:8px}" +
  ".dsh-usage-panel__detail-title{color:var(--dsw-alias-label-secondary);font-size:11px}" +
  ".dsh-usage-panel__date{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}" +
  ".dsh-usage-panel__hero{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}" +
  ".dsh-usage-panel__hero b{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-left:2px}" +
  ".dsh-usage-panel__sep{height:1px;background:rgba(128,128,140,.25);margin-bottom:8px}" +
  ".dsh-usage-panel__rows{display:grid;grid-template-columns:1fr 1fr;gap:4px 14px}" +
  ".dsh-usage-panel__row{display:flex;justify-content:space-between;gap:8px}" +
  ".dsh-usage-panel__row .lbl{color:var(--dsw-alias-label-secondary)}" +
  ".dsh-usage-panel__row .val{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}" +
  ".dsh-usage-panel__pager{display:flex;align-items:center;gap:6px;margin-bottom:6px}" +
  ".dsh-usage-panel__range{flex:1;text-align:center;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}" +
  ".dsh-usage-panel__nav{cursor:pointer;flex:none;width:22px;height:22px;padding:0;border:none;border-radius:8px;background:0 0;" +
  "color:var(--dsw-alias-label-primary);font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}" +
  ".dsh-usage-panel__nav:hover{background:rgba(128,128,140,.25)}" +
  ".dsh-usage-panel__nav:disabled{opacity:.35;cursor:default;background:0 0}" +
  ".dsh-usage-panel__cal{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}" +
  ".dsh-usage-panel__wd{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}" +
  ".dsh-usage-panel__wd--end{color:var(--dsw-alias-label-secondary)}" +
  ".dsh-usage-panel__blank{aspect-ratio:1/1}" +
  ".dsh-usage-panel__cell{box-sizing:border-box;aspect-ratio:1/1;padding:0;border:none;border-radius:7px;cursor:pointer;" +
  "color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;" +
  "font-variant-numeric:tabular-nums}" +
  ".dsh-usage-panel__cell:hover{outline:1px solid var(--dsw-alias-label-secondary)}" +
  ".dsh-usage-panel__cell--sel{outline:1.5px solid var(--dsw-alias-label-primary)}" +
  ".dsh-usage-panel__cell--future{opacity:.25;cursor:default}" +
  ".dsh-usage-panel__cell--today{box-shadow:inset 0 0 0 1px var(--dsw-alias-text-accent,#4c9aff)}" +
  ".dsh-usage-panel__legend{display:flex;align-items:center;gap:4px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}" +
  ".dsh-usage-panel__swatch{width:10px;height:10px;border-radius:2.5px;display:inline-block}" +
  ".dsh-usage-panel__hint{margin-left:auto;color:var(--dsw-alias-label-tertiary)}" +
  ".dsh-usage-panel__alltime{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}" +
  ".dsh-usage-panel__actions{display:flex;justify-content:flex-end;margin-top:8px}" +
  ".dsh-usage-panel__action{cursor:pointer;height:24px;padding:0 10px;border:none;border-radius:8px;background:rgba(128,128,140,.16);" +
  "color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:1}" +
  ".dsh-usage-panel__action:hover{background:rgba(128,128,140,.28);color:var(--dsw-alias-label-primary)}" +
  ".dsh-usage-panel__action:disabled{opacity:.5;cursor:default}" +
  "@media (prefers-reduced-motion:reduce){.dsh-usage-bar{transition:none}}";

		return module.exports;
	}
});
