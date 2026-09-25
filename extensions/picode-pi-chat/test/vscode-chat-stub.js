// Minimal stand-in for the `vscode` module, for the chat-participant and pi-tools
// tests. Only the surface those two modules touch is implemented.
//
// The two factories record what they were handed instead of discarding it, because the
// point of those tests is the wiring: that the participant is created under the id the
// manifest declares, and that the tools are registered under the names the manifest
// declares. A stub that threw the arguments away could not tell a wiring mistake from a
// working one.
const path = require("node:path");

const chat = {
  /** Every participant created through this module, in order. */
  participants: [],
  createChatParticipant: (id, handler) => {
    const participant = { id, handler, iconPath: undefined, dispose() {} };
    chat.participants.push(participant);
    return participant;
  },
};

const lm = {
  /** Every tool registered through this module, in order. */
  registered: [],
  registerTool: (name, tool) => {
    const handle = { name, tool, dispose() {} };
    lm.registered.push(handle);
    return handle;
  },
};

module.exports = {
  chat,
  lm,
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  Uri: {
    joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
    file: (fsPath) => ({ fsPath }),
  },
  LanguageModelToolResult: class LanguageModelToolResult {
    constructor(content) {
      this.content = content;
    }
  },
  LanguageModelTextPart: class LanguageModelTextPart {
    constructor(value) {
      this.value = value;
    }
  },
};
