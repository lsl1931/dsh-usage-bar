// dsh-usage-bar Node half: aggregate provider-reported token usage across all
// sessions (grand totals + per-local-day buckets) and expose JSON routes for
// the client pill and heatmap.
//
// Usage accounting follows the official @deepseek-ai/dsh-token-meter
// `tokenUsage` projection fold exactly:
// - `assistant/chunk` (chunk.type === "usage") provides an early sample;
// - `assistant/message` (data.usage) provides the final sample of the same
//   attempt and REPLACES the earlier sample instead of double counting;
// - `llm/retry-started` closes the replacement slot so the retried attempt
//   adds to the total.
// The replacement is applied both to grand totals and to the per-day buckets
// (a same-attempt replacement subtracts the sample's previous day first, so a
// midnight crossing attributes the correction to the right day).
// History backfill decodes the shipped session.jsonl.zstd artifacts
// (concatenated checksummed zstd frames) with node:zlib — zero extra deps.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// The usage a chunk or finalized message reports for its step, if any.
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

/** Local-calendar YYYY-MM-DD for an epoch-ms timestamp. */
export function dayKeyOf(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function eventDayKey(event) {
  const t = event?.time;
  const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : Date.now();
  return dayKeyOf(ms) ?? dayKeyOf(Date.now());
}

// --- one shared fold over usage events: totals + per-day buckets ---
// `last` mirrors the official projection's single replacement slot:
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
    // same attempt resample: replace — subtract the earlier sample from its day
    addBuckets(state.totals, previous.buckets, -1);
    const prevDay = state.daily[previous.day];
    if (prevDay) addBuckets(prevDay, previous.buckets, -1);
  }
  state.last = { turn, step, buckets, day };
}

/** Pure fold over an ordered event iterable → { totals, daily }. */
export function foldUsage(events) {
  const state = { totals: { ...ZERO }, daily: {}, last: null };
  for (const event of events) foldApply(state, event);
  return { totals: state.totals, daily: state.daily };
}

/** All-time view: sum every per-day bucket set (survives 清零, unlike totals). */
export function sumDaily(daily) {
  const totals = { ...ZERO };
  for (const b of Object.values(daily ?? {})) addBuckets(totals, b, 1);
  return totals;
}

// --- zstd multi-frame scanning (same container shape the persistence backend writes) ---

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

const PLUGIN_DIR = join(homedir(), ".dsh", "storages", "dsh-usage-bar");
const STORE_PATH = join(PLUGIN_DIR, "usage.json");

function loadStore() {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (raw && typeof raw === "object" && raw.totals && typeof raw.totals === "object") {
      const daily = {};
      if (raw.daily && typeof raw.daily === "object") {
        for (const [key, value] of Object.entries(raw.daily)) {
          if (typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key) && value && typeof value === "object") {
            daily[key] = { ...ZERO, ...value };
          }
        }
      }
      return {
        totals: { ...ZERO, ...raw.totals },
        daily,
        backfilled: Array.isArray(raw.backfilled) ? new Set(raw.backfilled) : new Set(),
        epoch: typeof raw.epoch === "number" ? raw.epoch : 0,
        dailyDone: raw.dailyDone === true,
      };
    }
  } catch {
    // first run or corrupt file: start clean
  }
  return { totals: { ...ZERO }, daily: {}, backfilled: new Set(), epoch: 0, dailyDone: false };
}

function serializeStore(store) {
  return JSON.stringify(
    {
      version: 2,
      totals: store.totals,
      daily: store.daily,
      backfilled: [...store.backfilled],
      epoch: store.epoch,
      dailyDone: store.dailyDone === true,
    },
    null,
    2,
  );
}

let saveTimer = null;
function scheduleSave(store) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(PLUGIN_DIR, { recursive: true });
      writeAtomic(STORE_PATH, serializeStore(store));
    } catch {
      // storage write failure is non-fatal; totals stay in memory
    }
  }, 2000);
}

function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Immediate synchronous persist (used by reset so the cleared total survives restart). */
function persistNow(store) {
  try {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    writeAtomic(STORE_PATH, serializeStore(store));
  } catch {
    // ignore: in-memory totals remain authoritative for this process
  }
}

/** Scan the sessions root; fold each session into the store.
 * - Sessions not yet in `backfilled`: fold into grand totals + daily, then mark.
 * - Sessions already marked while `dailyDone` is false: fold into daily ONLY
 *   (one-time migration so the heatmap covers history recorded before the
 *   daily buckets existed, without re-inflating the cleared/known totals).
 * `dailyDone` flips true only after a full uninterrupted pass. */
export function backfillOnce(store, sessionsRoot) {
  const epochAtStart = store.epoch;
  let projects;
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }
  let added = 0;
  for (const project of projects) {
    const projectDir = join(sessionsRoot, project.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("session-"));
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      // A reset during a slow scan cancels the rest of this backfill: the
      // cleared grand total must not be re-inflated by the in-flight scan.
      // dailyDone stays false, so the daily migration re-runs next boot.
      if (store.epoch !== epochAtStart) return added;
      const id = sd.name.slice("session-".length);
      const needTotals = !store.backfilled.has(id);
      const needDaily = !store.dailyDone;
      if (!needTotals && !needDaily) continue;
      let events = null;
      for (const name of ["session.jsonl.zstd", "session.jsonl"]) {
        try {
          const raw = readFileSync(join(projectDir, sd.name, name));
          events = name.endsWith(".zstd")
            ? decodeSessionLog(raw)
            : raw
                .toString("utf8")
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l));
          break;
        } catch {
          // try next artifact name
        }
      }
      if (!events) continue;
      const { totals, daily } = foldUsage(events);
      if (needTotals) {
        addBuckets(store.totals, totals, 1);
        store.backfilled.add(id);
      }
      if (needDaily) {
        for (const [day, buckets] of Object.entries(daily)) {
          const entry = store.daily[day] ?? (store.daily[day] = { ...ZERO });
          addBuckets(entry, buckets, 1);
        }
      }
      added++;
    }
  }
  store.dailyDone = true;
  return added;
}

export const inject = ["webServer"];

export function apply(ctx) {
  const log = () => ctx.logger ?? console;
  const store = loadStore();
  const sessionsRoot = join(homedir(), ".dsh", "sessions");

  // Per-session live fold state: replays the official replacement semantics so
  // a streamed usage chunk plus the final message sample count exactly once.
  const liveFolds = new Map(); // sessionId -> fold state { totals, daily, last }
  ctx.effect(
    () =>
      ctx.on("session/disposed", (session) => {
        liveFolds.delete(String(session?.id ?? ""));
      }),
    "dsh-usage-bar: live fold GC",
  );

  ctx.effect(
    () =>
      ctx.on("session/event", (session, event) => {
        try {
          if (usageOf(event) === undefined && event.type !== "llm/retry-started") return;
          const id = String(session?.id ?? "default");
          let state = liveFolds.get(id);
          if (!state) {
            state = { totals: { ...ZERO }, daily: {}, last: null };
            liveFolds.set(id, state);
          }
          const totalsBefore = { ...state.totals };
          // deep snapshot: foldApply mutates day entries in place, so the
          // delta computation must compare against a copy, not a reference
          const dailyBefore = JSON.parse(JSON.stringify(state.daily));
          foldApply(state, event);
          // Fold the per-session delta into the store: totals directly, daily
          // by comparing every touched day against its snapshot before the fold.
          const totalsDelta = {
            uncachedInputTokens: state.totals.uncachedInputTokens - totalsBefore.uncachedInputTokens,
            outputTokens: state.totals.outputTokens - totalsBefore.outputTokens,
            cacheReadTokens: state.totals.cacheReadTokens - totalsBefore.cacheReadTokens,
            cacheWriteTokens: state.totals.cacheWriteTokens - totalsBefore.cacheWriteTokens,
          };
          addBuckets(store.totals, totalsDelta, 1);
          const touchedDays = new Set();
          if (state.last) touchedDays.add(state.last.day);
          for (const day of Object.keys(dailyBefore)) touchedDays.add(day);
          for (const day of Object.keys(state.daily)) touchedDays.add(day);
          for (const day of touchedDays) {
            if (!day) continue;
            const after = state.daily[day] ?? { ...ZERO };
            const before = dailyBefore[day] ?? { ...ZERO };
            const delta = {
              uncachedInputTokens: after.uncachedInputTokens - before.uncachedInputTokens,
              outputTokens: after.outputTokens - before.outputTokens,
              cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
              cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
            };
            if (
              delta.uncachedInputTokens === 0 &&
              delta.outputTokens === 0 &&
              delta.cacheReadTokens === 0 &&
              delta.cacheWriteTokens === 0
            )
              continue;
            const entry = store.daily[day] ?? (store.daily[day] = { ...ZERO });
            addBuckets(entry, delta, 1);
          }
          scheduleSave(store);
        } catch (error) {
          log().warn?.(`dsh-usage-bar: session/event fold failed: ${String(error)}`);
        }
      }),
    "dsh-usage-bar: session/event capture",
  );

  // One JSON route for the client pill. Registered under a custom (non-/api)
  // path so it bypasses the dsh /api authentication gateway; GET only.
  const resetNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  ctx.effect(
    () =>
      ctx.webServer.register({
        path: "/dsh-usage-bar/summary",
        async handler(req, res) {
          const allTimeTotals = sumDaily(store.daily);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              resetNonce,
              totals: store.totals,
              billedInputTokens:
                store.totals.uncachedInputTokens + store.totals.cacheReadTokens + store.totals.cacheWriteTokens,
              totalTokens:
                store.totals.uncachedInputTokens +
                store.totals.outputTokens +
                store.totals.cacheReadTokens +
                store.totals.cacheWriteTokens,
              allTime: {
                totals: allTimeTotals,
                billedInputTokens:
                  allTimeTotals.uncachedInputTokens + allTimeTotals.cacheReadTokens + allTimeTotals.cacheWriteTokens,
                totalTokens:
                  allTimeTotals.uncachedInputTokens +
                  allTimeTotals.outputTokens +
                  allTimeTotals.cacheReadTokens +
                  allTimeTotals.cacheWriteTokens,
              },
              backfilledSessions: store.backfilled.size,
            }),
          );
        },
      }),
    "dsh-usage-bar: summary route",
  );

  // Per-day buckets for the heatmap panel; compact arrays keep it light.
  ctx.effect(
    () =>
      ctx.webServer.register({
        path: "/dsh-usage-bar/daily",
        async handler(req, res) {
          const daily = {};
          for (const [day, b] of Object.entries(store.daily)) {
            daily[day] = [b.uncachedInputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens];
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ daily }));
        },
      }),
    "dsh-usage-bar: daily route",
  );

  // Reset route: zero ONLY the grand total the pill shows. Daily heatmap
  // history is deliberately preserved, and the backfilled marker set stays so
  // a later restart does not replay history into the fresh total.
  ctx.effect(
    () =>
      ctx.webServer.register({
        path: "/dsh-usage-bar/reset",
        async handler(req, res) {
          if (req.url?.includes(`n=${resetNonce}`) !== true) {
            res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "bad_nonce" }));
            return;
          }
          try {
            store.totals = { ...ZERO };
            store.epoch += 1;
            liveFolds.clear();
            persistNow(store);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            log().warn?.(`dsh-usage-bar: reset failed: ${String(error)}`);
            res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false }));
          }
        },
      }),
    "dsh-usage-bar: reset route",
  );

  // Async history backfill: never delays startup.
  setTimeout(() => {
    try {
      const wasDailyDone = store.dailyDone;
      const added = backfillOnce(store, sessionsRoot);
      if (added > 0 || (!wasDailyDone && store.dailyDone)) scheduleSave(store);
    } catch (error) {
      log().warn?.(`dsh-usage-bar: backfill failed: ${String(error)}`);
    }
  }, 3000);
}
