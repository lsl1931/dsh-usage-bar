// dsh-usage-bar Node half: aggregate provider-reported token usage across all
// sessions and expose JSON routes for the client pill and heatmap.
//
// Usage accounting follows the official @deepseek-ai/dsh-token-meter
// \`tokenUsage\` projection fold exactly:
// - \`assistant/chunk\` (chunk.type === "usage") provides an early sample;
// - \`assistant/message\` (data.usage) provides the final sample of the same
//   attempt and REPLACES the earlier sample instead of double counting;
// - \`llm/retry-started\` closes the replacement slot so the retried attempt
//   adds to the total.
//
// The accounting MODEL is "recompute per session, then derive", not "accumulate":
// every session owns one ledger entry that is a pure function of its event log,
// and every displayed number is a sum over those entries. Re-observing a session
// therefore cannot change any number, which is what makes live capture and
// history backfill idempotent under each other and across restarts.
//
// Session discovery is delegated to the harness: ${ctx.sessionPersistence} owns
// home resolution, the project-directory layout, current-generation selection
// (session.v{N}.jsonl.zstd, highest N), and v2->v3 migration. The plugin does no
// filesystem path construction of its own.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// --- pure fold: the official replacement semantics ---

/** The usage a chunk or finalized message reports for its step, if any. */
function usageOf(event) {
  if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") return event.data.chunk.usage;
  if (event.type === "assistant/message" && event.data?.usage !== undefined) return event.data.usage;
  return undefined;
}

const bucketsFrom = (usage) => ({
  uncachedInputTokens: usage.inputTokens ?? 0,
  outputTokens: usage.outputTokens ?? 0,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});

const bucketsEqual = (a, b) =>
  a.uncachedInputTokens === b.uncachedInputTokens &&
  a.outputTokens === b.outputTokens &&
  a.cacheReadTokens === b.cacheReadTokens &&
  a.cacheWriteTokens === b.cacheWriteTokens;

function addBuckets(target, buckets, sign = 1) {
  target.uncachedInputTokens += sign * buckets.uncachedInputTokens;
  target.outputTokens += sign * buckets.outputTokens;
  target.cacheReadTokens += sign * buckets.cacheReadTokens;
  target.cacheWriteTokens += sign * buckets.cacheWriteTokens;
}

function subtractBuckets(a, b) {
  return {
    uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
  };
}

/** Local-calendar YYYY-MM-DD for an epoch-ms timestamp. */
export function dayKeyOf(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function eventTimeMs(event) {
  const t = event?.time;
  return typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : Date.now();
}

function eventDayKey(event) {
  const ms = eventTimeMs(event);
  return dayKeyOf(ms) ?? dayKeyOf(Date.now());
}

// --- one shared fold over usage events: totals + per-day buckets ---
// last mirrors the official projection's single replacement slot:
// { turn, step, buckets, day } or null.

function foldApply(state, event) {
  if (event.type === "llm/retry-started") {
    if (state.last && state.last.turn === event.data?.turn && state.last.step === event.data?.step) state.last = null;
    return;
  }
  const usage = usageOf(event);
  if (usage === undefined) return;
  const turn = event.data?.turn ?? 0;
  const step = event.data?.step ?? 0;
  const buckets = bucketsFrom(usage);
  const day = eventDayKey(event);
  const previous = state.last && state.last.turn === turn && state.last.step === step ? state.last : null;
  if (previous && bucketsEqual(previous.buckets, buckets)) return;
  addBuckets(state.totals, buckets, 1);
  const dayEntry = state.daily[day] ?? (state.daily[day] = { ...ZERO });
  addBuckets(dayEntry, buckets, 1);
  if (previous) {
    // same attempt resample: replace -- subtract the earlier sample from its day
    addBuckets(state.totals, previous.buckets, -1);
    const prevDay = state.daily[previous.day];
    if (prevDay) addBuckets(prevDay, previous.buckets, -1);
  }
  state.last = { turn, step, buckets, day };
}

/** Full fold state (totals + daily + the open replacement slot). Internal. */
function foldState(events) {
  const state = { totals: { ...ZERO }, daily: {}, last: null };
  for (const event of events) foldApply(state, event);
  return state;
}

/** Pure fold over an ordered event iterable -> { totals, daily }. */
export function foldUsage(events) {
  const state = foldState(events);
  return { totals: state.totals, daily: state.daily };
}

/** All-time view: sum every per-day bucket set. */
export function sumDaily(daily) {
  const totals = { ...ZERO };
  for (const b of Object.values(daily ?? {})) addBuckets(totals, b, 1);
  return totals;
}

// --- zstd multi-frame scanning (retained for offline log decoding) ---

function* zstdFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
      let next = buf.indexOf(magic, i + 4);
      if (next === -1) next = buf.length;
      yield buf.subarray(i, next);
      i = next;
    } else {
      i++;
    }
  }
}

/** Decode one session.jsonl.zstd artifact into its logical event objects. */
export function decodeSessionLog(buf) {
  const events = [];
  for (const frame of zstdFrames(buf)) {
    let text;
    try {
      text = zstdDecompressSync(frame).toString("utf8");
    } catch {
      continue; // torn or foreign frame: skip, stay best-effort
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
  return events;
}

// --- store: one ledger entry per session ---
//
// Shape (version 3):
//   {
//     version: 3,
//     resetAt: number,                     // epoch-ms of the last reset, 0 = never
//     sessions: { [id]: { totals, daily, floor } },
//   }
//
// totals/daily are the session's full folded usage; floor is the part of it that
// predates resetAt. "current" is the sum of (totals - floor) -- exactly the usage
// produced since the last reset, including the post-reset part of a resumed
// session. "allTime" and the calendar sum the full values.

const STORE_VERSION = 3;

/**
 * Resolve the harness home the way @deepseek-ai/dsh-home-paths documents it:
 * an explicit configured path (unavailable to a plugin) > $DSH_HOME > ~/.dsh.
 * An empty or whitespace-only $DSH_HOME counts as unset, so a blank override
 * never resolves the home to the current directory.
 * @returns the absolute harness home.
 */
export function resolveHarnessHome(env = process.env) {
  const override = env.DSH_HOME;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return join(homedir(), ".dsh");
}

// The store lives under the harness home's `storages` tree — the same root the
// official storage backend is configured with (dshHomePath('storages')).
const PLUGIN_DIR = join(resolveHarnessHome(), "storages", "dsh-usage-bar");
const STORE_PATH = join(PLUGIN_DIR, "usage.json");

export const emptyStore = () => ({ version: STORE_VERSION, resetAt: 0, sessions: {} });

const cloneBuckets = (b) => ({ ...ZERO, ...(b ?? {}) });

function cloneDaily(daily) {
  const out = {};
  for (const [day, b] of Object.entries(daily ?? {})) out[day] = cloneBuckets(b);
  return out;
}

function loadStore() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    return emptyStore(); // first run or corrupt file: start clean
  }
  if (!raw || typeof raw !== "object") return emptyStore();
  const store = emptyStore();
  if (raw.sessions && typeof raw.sessions === "object") {
    for (const [id, entry] of Object.entries(raw.sessions)) {
      if (typeof id !== "string" || !entry || typeof entry !== "object") continue;
      store.sessions[id] = {
        totals: cloneBuckets(entry.totals),
        daily: cloneDaily(entry.daily),
        floor: cloneBuckets(entry.floor),
      };
    }
    store.resetAt = typeof raw.resetAt === "number" ? raw.resetAt : 0;
    return store;
  }
  // v2 store: it held only a running total and a day map, with no per-session
  // ledger, so its numbers cannot be attributed to sessions. Rebuild from logs
  // instead -- the logs are the source of truth -- and carry the reset boundary
  // forward as "everything known so far is historical".
  store.resetAt = Date.now();
  return store;
}

function serializeStore(store) {
  return JSON.stringify(
    {
      version: STORE_VERSION,
      resetAt: store.resetAt,
      sessions: store.sessions,
    },
    null,
    2,
  );
}

function writeAtomic(path, data) {
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Persist the ledger. Fail-soft by design: a storage failure must not break the
 * plugin, and the in-memory ledger stays authoritative. But a SILENT failure
 * degrades to in-memory-only with no signal at all, so the first failure is
 * reported through the plugin's logger and subsequent ones are counted.
 * @param store - the ledger to write.
 * @param log - optional reporter; omitted in tests that do not exercise logging.
 * @returns true when the write succeeded.
 */
function persist(store, log) {
  try {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    writeAtomic(STORE_PATH, serializeStore(store));
    return true;
  } catch (error) {
    persistFailures += 1;
    if (persistFailures === 1) {
      log?.warn?.(
        "dsh-usage-bar: could not persist the usage ledger to " + STORE_PATH +
        " (" + String(error) + "); usage is tracked in memory only until a write succeeds",
      );
    }
    return false;
  }
}

/** Number of failed persist attempts since load; reported once, then counted. */
let persistFailures = 0;

// --- derived views ---

function sumOverSessions(store, pick) {
  const totals = { ...ZERO };
  for (const entry of Object.values(store.sessions)) addBuckets(totals, pick(entry), 1);
  return totals;
}

/** "allTime": every session's full folded usage. */
export const allTimeTotals = (store) => sumOverSessions(store, (e) => e.totals);

/** Calendar heatmap: every session's per-day buckets, merged. */
export function allTimeDaily(store) {
  const daily = {};
  for (const entry of Object.values(store.sessions)) {
    for (const [day, b] of Object.entries(entry.daily ?? {})) {
      const target = daily[day] ?? (daily[day] = { ...ZERO });
      addBuckets(target, b, 1);
    }
  }
  return daily;
}

/** "current": the usage produced since the last reset. */
export const currentTotals = (store) => sumOverSessions(store, (e) => subtractBuckets(e.totals, e.floor));

/** The part of one session's usage that predates the last reset. */
function floorOf(events, resetAt) {
  if (resetAt === 0) return { ...ZERO };
  return foldState(events.filter((event) => eventTimeMs(event) <= resetAt)).totals;
}

// --- backfill ---

/**
 * Fold sessions into the ledger. \`sessions\` is an async iterable of
 * { id, events }; the caller owns discovery (sessionPersistence in production,
 * fixtures in tests). A session already in the ledger is skipped, so a re-run
 * after an interruption is idempotent, and a session counted live is never
 * counted again here.
 * @returns the number of sessions folded.
 */
export async function backfillOnce(store, sessions) {
  let added = 0;
  for await (const { id, events } of sessions) {
    if (typeof id !== "string" || id === "" || store.sessions[id] !== undefined) continue;
    const folded = foldState(events);
    store.sessions[id] = {
      totals: folded.totals,
      daily: folded.daily,
      floor: floorOf(events, store.resetAt),
    };
    added++;
  }
  return added;
}

/** Enumerate sessions the ledger does not know yet, through the harness. */
export async function* persistedSessions(persistence, store) {
  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch {
    return; // no readable store: leave history absent rather than guess
  }
  for (const snapshot of snapshots) {
    const id = String(snapshot?.header?.id ?? "");
    if (id === "" || store.sessions[id] !== undefined) continue;
    let handle;
    try {
      handle = await persistence.open(id, "read");
      const result = await handle.read();
      yield { id, events: result.events };
    } catch {
      // unreadable or unsupported session: skip, stay best-effort
    } finally {
      try {
        await handle?.close();
      } catch {
        // closing a read handle cannot fail in a way we can act on
      }
    }
  }
}

export const inject = ["webServer", "connection"];

export function apply(ctx) {
  const store = loadStore();
  const persistence = ctx.get("sessionPersistence");

  // Per-session live fold, seeded from the session's own log so a RESUMED
  // session starts from its full history rather than from this boot's events.
  //
  // `observedSeq` is the watermark that makes this safe: `session/event` fires
  // AFTER the event is committed, so the snapshot already contains the event
  // being delivered. Folding it again would double-count it. The official
  // projection guards the same way (session-projection's advanceCell advances
  // only up to the cursor before the session's current seq), so a delivered
  // event is folded exactly once.
  const liveFolds = new Map(); // sessionId -> { totals, daily, last, floor, observedSeq }

  const seqOf = (event) => (typeof event?.seq === "number" ? event.seq : -1);

  const liveStateOf = (session) => {
    const id = String(session.id);
    let state = liveFolds.get(id);
    if (state === undefined) {
      const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
      const folded = foldState(events);
      state = {
        totals: folded.totals,
        daily: folded.daily,
        last: folded.last,
        floor: floorOf(events, store.resetAt),
        observedSeq: events.reduce((max, e) => Math.max(max, seqOf(e)), -1),
      };
      liveFolds.set(id, state);
    }
    return { id, state };
  };

  /**
   * Write one live session's ledger entry from its fold state.
   *
   * The ledger entry SHARES the fold state's `daily` map by reference rather than
   * cloning it. Both objects are owned by this plugin and mutated only by
   * `foldApply`, so sharing is safe, and it keeps this off the O(days) path:
   * this runs once per usage event, and a deep clone of the day map made the
   * per-event cost grow with the session's day count (measured 5.8us at 2 days
   * vs 29.7us at 365 days). `totals` and `floor` are 4-field objects, so
   * copying those is free.
   */
  const flushSession = (id, state) => {
    store.sessions[id] = { totals: { ...state.totals }, daily: state.daily, floor: { ...state.floor } };
  };

  let saveTimer = null;
  let backfillTimer = null;

  const scheduleSave = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist(store, ctx.logger);
    }, 2000);
  };

  // Every timer this plugin owns is cleared with its fiber.
  ctx.effect(
    () => () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      if (backfillTimer !== null) clearTimeout(backfillTimer);
      backfillTimer = null;
    },
    "dsh-usage-bar: timers",
  );

  ctx.effect(
    () =>
      ctx.on("session/event", (session, event) => {
        try {
          if (usageOf(event) === undefined && event.type !== "llm/retry-started") return;
          const { id, state } = liveStateOf(session);
          // Already folded as part of the seeding snapshot: ignore. This is what
          // keeps a replayed/duplicated delivery from counting twice.
          const seq = seqOf(event);
          if (seq !== -1 && seq <= state.observedSeq) return;
          foldApply(state, event);
          if (seq !== -1) state.observedSeq = seq;
          flushSession(id, state);
          scheduleSave();
        } catch (error) {
          ctx.logger?.warn?.("dsh-usage-bar: session/event fold failed: " + String(error));
        }
      }),
    "dsh-usage-bar: session/event capture",
  );

  // A session that ends is the natural durable point: its log is complete.
  ctx.effect(
    () =>
      ctx.on("session/disposed", (session) => {
        try {
          const id = String(session?.id ?? "");
          const state = liveFolds.get(id);
          if (state !== undefined) flushSession(id, state);
          liveFolds.delete(id);
          persist(store, ctx.logger);
        } catch (error) {
          ctx.logger?.warn?.("dsh-usage-bar: dispose flush failed: " + String(error));
        }
      }),
    "dsh-usage-bar: dispose flush",
  );

  // Per-launch reset secret, issued only behind the trust fence.
  const resetNonce = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.writeHead(rejection);
    res.end();
    return true;
  };

  const sendJson = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const methodNotAllowed = (res, allowed) => {
    res.writeHead(405, { allow: allowed, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
  };

  const view = (totals) => ({
    totals,
    billedInputTokens: totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    totalTokens:
      totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  });

  // One JSON route for the client pill. kind: "exact" is explicit: the webserver
  // routes anything else into the longest-prefix table.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-usage-bar/summary",
        async handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            methodNotAllowed(res, "GET");
            return;
          }
          sendJson(res, 200, {
            current: view(currentTotals(store)),
            allTime: view(allTimeTotals(store)),
            backfilledSessions: Object.keys(store.sessions).length,
            resetAt: store.resetAt,
          });
        },
      }),
    "dsh-usage-bar: summary route",
  );

  // Per-day buckets for the heatmap panel; compact arrays keep it light.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-usage-bar/daily",
        async handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            methodNotAllowed(res, "GET");
            return;
          }
          const daily = {};
          for (const [day, b] of Object.entries(allTimeDaily(store))) {
            daily[day] = [b.uncachedInputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens];
          }
          sendJson(res, 200, { daily });
        },
      }),
    "dsh-usage-bar: daily route",
  );

  // Reset secret, issued behind the fence so an unauthenticated caller cannot
  // obtain it from the summary endpoint.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-usage-bar/nonce",
        async handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "POST") {
            methodNotAllowed(res, "POST");
            return;
          }
          sendJson(res, 200, { nonce: resetNonce });
        },
      }),
    "dsh-usage-bar: nonce route",
  );

  // Reset route: start a new "current" period. Each session's floor is set to
  // its current totals, so the period total reads zero immediately and only
  // usage produced afterwards counts -- across restarts, because the boundary
  // is persisted rather than a counter.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-usage-bar/reset",
        async handler(req, res) {
          if (rejected(req, res)) return;
          if (req.method !== "POST") {
            methodNotAllowed(res, "POST");
            return;
          }
          if (req.headers["x-dsh-usage-bar-nonce"] !== resetNonce) {
            sendJson(res, 403, { ok: false, error: "bad_nonce" });
            return;
          }
          try {
            store.resetAt = Date.now();
            for (const entry of Object.values(store.sessions)) entry.floor = { ...entry.totals };
            for (const state of liveFolds.values()) state.floor = { ...state.totals };
            persist(store, ctx.logger);
            sendJson(res, 200, { ok: true });
          } catch (error) {
            ctx.logger?.warn?.("dsh-usage-bar: reset failed: " + String(error));
            sendJson(res, 500, { ok: false });
          }
        },
      }),
    "dsh-usage-bar: reset route",
  );

  // Async history backfill: never delays startup, never blocks the event loop
  // for the whole scan (each session's fold is separated by an await).
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    if (persistence === undefined) return; // no history source: live-only
    backfillOnce(store, persistedSessions(persistence, store))
      .then((added) => {
        if (added > 0) persist(store, ctx.logger);
      })
      .catch((error) => {
        ctx.logger?.warn?.("dsh-usage-bar: backfill failed: " + String(error));
      });
  }, 3000);
}