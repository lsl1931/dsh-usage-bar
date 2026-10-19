// Run every selftest in its own process and fail on the first red.
//
// Each test pins DSH_HOME to its own throwaway directory at module-evaluation
// time (test-isolation.mjs), so they must NOT share a process: this runner
// spawns one child per file, in name order, and reports a summary.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SELF = "selftest-all.mjs";
const files = readdirSync(root)
  .filter((name) => /^selftest.*\.mjs$/.test(name) && name !== SELF)
  .sort();

if (files.length === 0) {
  console.error("no selftests found next to " + root);
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(root, file)], {
    encoding: "utf8",
    // A live timer or an undrained event loop is exactly this plugin's failure
    // mode; without a timeout one hung child would hang `npm test` forever
    // instead of failing. A killed child reports status null, which already
    // reads as FAIL below.
    timeout: 120000,
    killSignal: "SIGKILL",
  });
  const ms = Date.now() - started;
  const ok = result.status === 0;
  const tail = (result.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  console.log((ok ? "PASS " : "FAIL ") + file + " (" + ms + "ms)" + (ok ? "" : "\n" + (result.stdout || "") + (result.stderr || "")));
  if (ok && tail !== "") console.log("     " + tail);
  if (!ok) failed.push(file);
}

console.log("\n" + (files.length - failed.length) + "/" + files.length + " selftests passed");
if (failed.length > 0) {
  console.error("failed: " + failed.join(", "));
  process.exit(1);
}
