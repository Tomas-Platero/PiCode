/*
 * A `vscode` stand-in with a real webview panel, for the suites that drive a whole surface.
 *
 * `vscode-stub.js` covers the resolver's needs — configuration and `Uri` — and is enough for
 * anything that never opens a panel. This one goes further on purpose: it records the panels
 * that were created, whether each was revealed instead of duplicated, the messages the host
 * posts and the messages the webview sends, and it keeps the editor's own settings so a write
 * can be read back. That is what makes "the panel is one tab per window" and "the list is sent
 * again after applying" observable instead of inferred from the source.
 *
 * Everything the modules under test touch is here; nothing else is invented. State is exposed
 * through `__state` so a suite can read what happened and set what the editor reports.
 */
const state = {
  /** One entry per `createWebviewPanel`, in the order they were opened. */
  panels: [],
  reveals: 0,
  /** What the host posted to the webview, newest last. */
  posted: [],
  /** Messages the webview sent to the host, newest last. */
  received: [],
  /** Commands the host ran. */
  commands: [],
  /** The editor's settings, keyed `<section>.<key>`. */
  settings: {},
  external: [],
  extensions: [],
};

function makeWebview() {
  const messageHandlers = [];
  return {
    cspSource: "vscode-webview://stub",
    html: "",
    // A real `asWebviewUri` answers a Uri whose string form is the URL the webview loads, and
    // the document builder writes that string: a stub returning a bare object would make every
    // script and style tag render as `[object Object]` and the check would report a missing file
    // that is actually there.
    asWebviewUri: (uri) => ({
      fsPath: uri.fsPath,
      toString: () => `vscode-webview://stub/${String(uri.fsPath).split(/[\\/]/).pop()}`,
    }),
    postMessage(message) {
      state.posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage(handler) {
      messageHandlers.push(handler);
      return { dispose() {} };
    },
    /** The suite calls this as if the webview had posted a message. */
    __receive(message) {
      state.received.push(message);
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
  };
}

function makePanel(viewType, title) {
  const disposeHandlers = [];
  const webview = makeWebview();
  const panel = {
    viewType,
    title,
    webview,
    revealed: false,
    disposed: false,
    reveal() {
      panel.revealed = true;
      state.reveals += 1;
    },
    onDidDispose(handler) {
      disposeHandlers.push(handler);
      return { dispose() {} };
    },
    dispose() {
      if (panel.disposed) {
        return;
      }
      panel.disposed = true;
      for (const handler of disposeHandlers) {
        handler();
      }
    },
    /** The suite simulates the owner closing the tab. */
    __close() {
      panel.dispose();
    },
    /** The suite simulates the webview posting a message, which is what the panel would see. */
    __receive(message) {
      webview.__receive(message);
    },
  };
  state.panels.push(panel);
  return panel;
}

module.exports = {
  __state: state,
  window: {
    createWebviewPanel: (viewType, title) => makePanel(viewType, title),
    showErrorMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: (section) => ({
      get: (key, fallback) =>
        Object.hasOwn(state.settings, `${section}.${key}`)
          ? state.settings[`${section}.${key}`]
          : fallback,
      update: async (key, value) => {
        state.settings[`${section}.${key}`] = value;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async (command, ...args) => {
      state.commands.push({ command, args });
      return undefined;
    },
    registerCommand: () => ({ dispose() {} }),
  },
  extensions: {
    get all() {
      return state.extensions;
    },
    getExtension: (id) => state.extensions.find((extension) => extension.id === id),
  },
  env: {
    openExternal: async (uri) => {
      state.external.push(uri);
      return true;
    },
  },
  Uri: {
    joinPath: (uri, ...parts) => ({ fsPath: [uri.fsPath, ...parts].join("/") }),
    file: (fsPath) => ({ fsPath }),
    parse: (value) => ({ fsPath: value, toString: () => value }),
  },
  ViewColumn: { Active: -1, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  EventEmitter: class {
    constructor() {
      this.listeners = [];
      this.event = (listener) => {
        this.listeners.push(listener);
        return { dispose() {} };
      };
    }
    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {}
  },
  Disposable: { from: () => ({ dispose() {} }) },
};
