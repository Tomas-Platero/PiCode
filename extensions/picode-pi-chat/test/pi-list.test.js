/*
 * Exercises the `pi list` parser.
 *
 * The parser turns a human-readable listing into the rows the extensions view
 * renders, and the shape of that listing is not a documented contract. The first
 * fixture below is real output captured from pi 0.86.1 on this machine, so a pi
 * release that changes the format fails here rather than showing an empty list
 * that reads as "nothing installed".
 *
 * Run with: npm test
 */
const path = require("node:path");
const Module = require("node:module");

// pi-cli.ts imports runtime.ts, which imports `vscode`. The stub keeps the parser
// testable outside an editor.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { parseInstalledPackages } = require("../out/pi-cli.js");

const REAL_OUTPUT = [
  "User packages:",
  "  npm:pi-web-access",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-web-access",
  "  npm:@tintinweb/pi-subagents",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\@tintinweb\\pi-subagents",
  "  npm:pi-lens",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-lens",
  "  npm:pi-intercom",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-intercom",
  "  npm:@juicesharp/rpiv-ask-user-question",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\@juicesharp\\rpiv-ask-user-question",
  "  npm:pi-btw",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-btw",
  "  npm:@quintinshaw/pi-dynamic-workflows",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\@quintinshaw\\pi-dynamic-workflows",
  "  npm:@rohaquinlop/pi-deepseek-cache",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\@rohaquinlop\\pi-deepseek-cache",
  "  npm:pi-deepseek-search",
  "    C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-deepseek-search",
  "  git:github.com/HazAT/pi-interactive-subagents",
  "",
].join("\r\n");

const WITH_PROJECT_SCOPE = [
  "User packages:",
  "  npm:pi-lens",
  "    C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\pi-lens",
  "",
  "Project packages:",
  "  npm:gentle-pi",
  "    D:\\work\\.pi\\npm\\node_modules\\gentle-pi",
  "",
].join("\n");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const real = parseInstalledPackages(REAL_OUTPUT);
check("real output yields every package", real.length === 10, `${real.length} parsed`);
check(
  "the CRLF line endings real output uses do not leak into a name",
  real[0] && real[0].source === "npm:pi-web-access",
  real[0] && JSON.stringify(real[0].source),
);
check(
  "every package belongs to the section above it",
  real.every((entry) => entry.scope === "User packages"),
  JSON.stringify([...new Set(real.map((entry) => entry.scope))]),
);
check(
  "the path on the following line attaches to its package",
  real[2].path === "C:\\Users\\tapla\\.pi\\agent\\npm\\node_modules\\pi-lens",
  real[2].path,
);
check(
  "a package with no path still parses",
  real[9].source === "git:github.com/HazAT/pi-interactive-subagents" &&
    real[9].path === undefined,
  JSON.stringify(real[9]),
);

const project = parseInstalledPackages(WITH_PROJECT_SCOPE);
check("a second section is kept apart from the first", project.length === 2, `${project.length} parsed`);
check(
  "the project entry carries its own scope",
  project[1] && project[1].scope === "Project packages" && project[1].source === "npm:gentle-pi",
  JSON.stringify(project[1]),
);

check("empty output yields nothing rather than a bogus row", parseInstalledPackages("").length === 0, "");
check(
  "a bare heading yields nothing",
  parseInstalledPackages("User packages:\n").length === 0,
  "",
);
check(
  "prose outside a section is ignored",
  parseInstalledPackages("Nothing installed yet.\n").length === 0,
  "",
);

let failed = 0;
for (const result of results) {
  console.log(
    `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
  );
  if (!result.ok) {
    failed += 1;
  }
}
console.log(
  failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
