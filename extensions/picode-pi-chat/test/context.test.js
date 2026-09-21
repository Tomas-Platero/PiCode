/*
 * Exercises the editor-context block.
 *
 * What a message contains is a contract with the agent: if the block says a selection
 * was attached, the text has to be there, and if the text was too long to carry the
 * block has to say so. A silent truncation would make the agent reason about a file
 * as if it had seen all of it.
 *
 * context.ts imports `vscode` for the collector, stubbed through a hook so the pure
 * half can be checked here.
 *
 * Run with: npm test
 */
const path = require("node:path");
const Module = require("node:module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const { composePrompt, truncateBody, MAX_INLINE_CHARS } = require("../out/context.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

// --- passthrough -----------------------------------------------------------

check("with no references the message is untouched", composePrompt("hola", []) === "hola", "");

// --- the block -------------------------------------------------------------

const withList = composePrompt("arregla esto", [
  { kind: "workspace", label: "carpeta abierta: PiCode (D:\\repositorios\\PiCode)" },
  { kind: "file", label: "archivo activo: src/auth.ts (typescript, 120 líneas)" },
]);
check(
  "a listed reference appears as a bullet",
  withList.startsWith("[Contexto del editor en PiCode]\n- carpeta abierta") &&
    withList.includes("- archivo activo: src/auth.ts"),
  JSON.stringify(withList.split("\n").slice(0, 3)),
);
check("the owner's words come last", withList.trimEnd().endsWith("arregla esto"), "");
check("the block is separated from the message", withList.includes("\n---\n\narregla esto"), "");

const withBody = composePrompt("mira esto", [
  { kind: "file", label: "archivo activo: src/auth.ts (typescript, 120 líneas)" },
  { kind: "selection", label: "selección en src/auth.ts (líneas 40-42)", body: "const a = 1;\nconst b = 2;" },
]);
check(
  "a selection is carried inline under its own heading",
  withBody.includes("--- selección en src/auth.ts (líneas 40-42) ---\nconst a = 1;\nconst b = 2;"),
  JSON.stringify(withBody),
);
check(
  "a reference with a body is not also listed as a bullet",
  // Checked line by line: the heading is `--- seleccion ... ---`, which contains
  // `- seleccion` as a substring and would match a naive contains.
  !withBody
    .split("\n")
    .some((line) => line.startsWith("- ") && line.includes("selección en src/auth.ts")),
  JSON.stringify(withBody.split("\n").filter((line) => line.startsWith("- "))),
);
check(
  "the file the selection belongs to is still listed",
  withBody.includes("- archivo activo: src/auth.ts"),
  "",
);

// --- truncation ------------------------------------------------------------

check("a short body is untouched", truncateBody("corto") === "corto", "");

const long = "x".repeat(MAX_INLINE_CHARS + 500);
const truncated = truncateBody(long);
check("an oversized body is cut to the limit", truncated.startsWith("x".repeat(100)), "");
check(
  "the cut is declared, with how much was dropped",
  truncated.includes("[... recortado: 500 caracteres más."),
  truncated.slice(-90),
);

const composed = composePrompt("sigue", [
  { kind: "selection", label: "selección grande", body: long },
]);
check(
  "the truncation notice reaches the message the agent receives",
  composed.includes("[... recortado: 500 caracteres más."),
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
