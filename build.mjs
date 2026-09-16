// Build dsh-usage-bar (zero-dependency): emits
// - lib/index.js  (Node half, verbatim copy of src/index.js)
// - lib/client.js (browser half wrapped in the factory-form CJS the dsh
//   client-modules system registers: window.__ModuleLoader__.load({id,factory}))
// The client source is JSX-free and already in the exact export shape the
// loader expects (exports.inject / exports.apply), so no transpiler is needed.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const libDir = join(root, "lib");
mkdirSync(libDir, { recursive: true });

// 1) Node half: plain ESM — copy verbatim.
copyFileSync(join(root, "src", "index.js"), join(libDir, "index.js"));
console.log("lib/index.js written");

// 2) Client half: wrap the CJS body in the ModuleLoader factory form.
const body = readFileSync(join(root, "src", "client", "index.js"), "utf8");
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-usage-bar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`;
writeFileSync(join(libDir, "client.js"), wrapped);
console.log("lib/client.js written");
