// Test isolation: point DSH_HOME at a throwaway directory BEFORE lib/index.js is
// imported, so nothing a test does can reach the user's real ledger.
//
// Why this file exists: the store path is derived from DSH_HOME, and several
// tests call apply() which persists. Without isolation those tests wrote into
// the developer's own `<DSH_HOME>/storages/dsh-usage-bar/usage.json` -- a real
// incident, not a hypothetical. Import this FIRST, before lib/index.js.
//
// ESM hoists imports, so setting process.env inside a test body is too late: the
// module graph (and therefore the captured path) is already evaluated. The
// helper must be imported as the first statement, and it sets the variable at
// module-evaluation time.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "dsh-usage-bar-test-"));

/** The throwaway harness home this process should use. */
export const TEST_DSH_HOME = sandbox;

/** Directory holding the test's own ledger; safe to read in assertions. */
export const TEST_STORE_DIR = join(sandbox, "storages", "dsh-usage-bar");
export const TEST_STORE_PATH = join(TEST_STORE_DIR, "usage.json");

/** Real session logs, read-only. Empty when the machine has none. */
export const REAL_SESSIONS_DIR = join(
  process.env.DSH_USAGE_BAR_REAL_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh"),
  "sessions",
);

// Capture the real home for read-only fixtures, then redirect writes.
if (process.env.DSH_USAGE_BAR_KEEP_REAL_HOME !== "1") {
  process.env.DSH_HOME = sandbox;
}

process.on("exit", () => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});
