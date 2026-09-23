// The theme panel's bootstrap: it hands the shared gallery its container and its channel.
//
// The whole surface lives in `theme-gallery.js`, which the wizard's theme step mounts too.
// This file exists so that the panel document has one script that owns the VS Code API and
// nothing else: a second copy of the mount call is how the two surfaces would start to drift.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();
  var root = document.getElementById("theme-root");

  function send(message) {
    vscode.postMessage(message);
  }

  // Mounted before the first host message arrives, so the rows the host already pushed find
  // a gallery to land in rather than being dropped on the floor.
  globalThis.PiCodeThemeGallery.mount(root, { post: send, compact: false });

  window.addEventListener("message", function (event) {
    globalThis.PiCodeThemeGallery.feed(event.data);
  });

  send({ type: "ready" });
})();
