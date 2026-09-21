// Minimal stand-in for the `vscode` module, so the compiled runtime resolver can
// be exercised in plain Node. Only what runtime.ts actually calls is implemented.
//
// Configuration is read from the environment so each resolution mode can be
// tested without an editor.
const path = require("node:path");

module.exports = {
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => {
        if (key === "runtime") {
          return process.env.TEST_RUNTIME_MODE ?? fallback;
        }
        if (key === "executablePath") {
          return process.env.TEST_EXECUTABLE_PATH ?? fallback;
        }
        return fallback;
      },
    }),
  },
  Uri: {
    joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
    file: (fsPath) => ({ fsPath }),
  },
};
