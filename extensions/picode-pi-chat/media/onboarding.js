// PiCode's initial-setup wizard.
//
// Presentation only. The runtime reading, Gentle AI's state and every action come
// from the host, which delegates them to the same functions the rest of the editor
// uses; this script draws the two questions, sends the answer and shows the outcome
// the host reports in place. A failure stays here instead of being swallowed: the
// editor's notification can be gone by the time the owner looks back at the panel.
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  var elements = {
    notice: document.getElementById("notice"),
    stepTabs: [
      document.getElementById("step-tab-pi"),
      document.getElementById("step-tab-gentle"),
      document.getElementById("step-tab-theme"),
      document.getElementById("step-tab-summary"),
    ],
    piSection: document.getElementById("step-pi"),
    gentleSection: document.getElementById("step-gentle"),
    themeSection: document.getElementById("step-theme"),
    themeRoot: document.getElementById("wizard-theme-root"),
    themeNote: document.getElementById("wizard-theme-note"),
    themeContinue: document.getElementById("wizard-theme-continue"),
    summarySection: document.getElementById("step-summary"),
    runtimeCurrent: document.getElementById("runtime-current"),
    runtimeChoices: document.getElementById("runtime-choices"),
    runtimeCustom: document.getElementById("runtime-custom"),
    runtimePath: document.getElementById("runtime-path"),
    runtimeApply: document.getElementById("runtime-apply"),
    runtimeResult: document.getElementById("runtime-result"),
    profilePart: document.getElementById("profile-part"),
    profilePartText: document.getElementById("profile-part-text"),
    profilePartOffers: document.getElementById("profile-part-offers"),
    profilePartContinue: document.getElementById("profile-part-continue"),
    gentleCurrent: document.getElementById("gentle-current"),
    gentleInstall: document.getElementById("gentle-install"),
    gentleSkip: document.getElementById("gentle-skip"),
    gentleResult: document.getElementById("gentle-result"),
    summaryRuntime: document.getElementById("summary-runtime"),
    summaryGentle: document.getElementById("summary-gentle"),
    openChat: document.getElementById("open-chat"),
    openSettings: document.getElementById("open-settings"),
    openGentle: document.getElementById("open-gentle"),
    finish: document.getElementById("finish"),
  };

  // The three modes `runtime.ts` resolves, in the order the question offers them.
  var MODES = [
    {
      id: "path",
      label: "El pi que ya está en el PATH",
      detail: "Tu instalación propia. Cambia cuando actualices pi.",
    },
    {
      id: "managed",
      label: "El pi propio de PiCode",
      detail: "Instalado dentro de la distribución, con versión fijada.",
    },
    {
      id: "custom",
      label: "Otra instalación, por ruta",
      detail: "Usa exactamente la ruta que escribas abajo.",
    },
  ];

  var state = {
    step: "pi",
    runtime: null,
    gentle: null,
    profile: null,
    configuredPath: "",
    mode: null,
  };

  function send(message) {
    vscode.postMessage(message);
  }

  function createElement(tag, className, text) {
    var element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (typeof text === "string") {
      element.textContent = text;
    }
    return element;
  }

  function showNotice(text) {
    elements.notice.textContent = typeof text === "string" ? text : "";
    elements.notice.hidden = elements.notice.textContent.length === 0;
  }

  // A result line reads differently depending on whether it reports a success, so the
  // class carries that and the message stays the host's words.
  function showResult(element, ok, message) {
    element.textContent = typeof message === "string" ? message : "";
    element.hidden = element.textContent.length === 0;
    element.classList.toggle("ok", ok === true);
    element.classList.toggle("failed", ok === false);
  }

  // --- the pi question ----------------------------------------------------

  var MODE_LABELS = {
    path: "el pi del PATH",
    managed: "el pi propio de PiCode",
    custom: "una instalación por ruta",
  };

  function runtimeLine(runtime) {
    if (!runtime) {
      return "Leyendo el pi en uso…";
    }
    var version = runtime.version ? runtime.version : "versión no disponible";
    var found = runtime.available ? "" : " · el ejecutable no está";
    return "En uso ahora: " + (MODE_LABELS[runtime.mode] || runtime.mode) + " · " + version + found;
  }

  function modeDetail(option, runtime) {
    if (!runtime) {
      return option.detail;
    }
    if (option.id === "managed") {
      if (runtime.managedInstalled) {
        return "Ya está instalado en " + runtime.managedRoot + ".";
      }
      var pin = runtime.pin && runtime.pin.version ? runtime.pin.version : "la fijada";
      return (
        "Se instala en la carpeta de PiCode con la versión " +
        pin +
        ". Descarga unos cientos de megabytes. Tu pi global no se toca."
      );
    }
    if (option.id === "path") {
      return runtime.mode === "path" && runtime.version
        ? "Ahora mismo resuelve " + runtime.version + "."
        : "Se resuelve en el PATH. Ahora mismo no hay ninguno disponible.";
    }
    return option.detail;
  }

  function modeChoice(option, runtime) {
    var label = createElement("label", "onboarding-choice");
    var input = document.createElement("input");
    input.type = "radio";
    input.name = "runtime-mode";
    input.value = option.id;
    input.checked = state.mode === option.id;
    input.addEventListener("change", function () {
      state.mode = option.id;
      renderRuntime();
    });
    label.appendChild(input);

    var text = createElement("span", "onboarding-choice-text");
    text.appendChild(createElement("span", "onboarding-choice-label", option.label));
    text.appendChild(createElement("span", "onboarding-choice-detail", modeDetail(option, runtime)));
    label.appendChild(text);
    return label;
  }

  function renderRuntime() {
    var runtime = state.runtime;
    elements.runtimeCurrent.textContent = runtimeLine(runtime);
    if (state.mode === null) {
      state.mode = runtime ? runtime.mode : "path";
    }

    elements.runtimeChoices.textContent = "";
    for (var index = 0; index < MODES.length; index += 1) {
      elements.runtimeChoices.appendChild(modeChoice(MODES[index], runtime));
    }

    elements.runtimeCustom.hidden = state.mode !== "custom";
    if (document.activeElement !== elements.runtimePath) {
      elements.runtimePath.value = state.configuredPath || "";
    }
  }

  // --- the pi step's profile part -----------------------------------------

  // Nothing is decided here. The host sends the part already decided — `visible`, `text`,
  // `offers` — from the same facts the settings row states, so this renderer only draws it:
  // a second decision in the webview would be the second wording of one fact. Each button
  // carries the command id its offer names, and this script never decides what runs.
  //
  // The part describes the pi in force, not the radio's pending choice: the editor is still
  // running the pi it had until the owner presses "Aplicar este pi", and that is exactly the
  // case the sentence has to be honest about.
  function offerButton(offer) {
    var button = createElement("button", "onboarding-button", offer.label);
    button.type = "button";
    button.addEventListener("click", function () {
      send({ type: "runOffer", command: offer.command });
    });
    return button;
  }

  // The one fact the part and the step's own way forward share, read from the host's own
  // decision. While it is true the step has something to say: it does not move on by itself,
  // and the button that moves it on is inside the part, so the two cannot disagree about
  // whether the owner still needs a way out.
  function profilePartVisible() {
    return state.profile !== null && state.profile.visible === true;
  }

  function renderProfilePart() {
    var part = state.profile;
    var visible = profilePartVisible();
    elements.profilePart.hidden = !visible;
    elements.profilePartText.textContent =
      visible && typeof part.text === "string" ? part.text : "";
    elements.profilePartOffers.textContent = "";
    if (!visible || !Array.isArray(part.offers)) {
      return;
    }
    for (var index = 0; index < part.offers.length; index += 1) {
      var offer = part.offers[index];
      if (!offer || typeof offer.label !== "string" || typeof offer.command !== "string") {
        continue;
      }
      elements.profilePartOffers.appendChild(offerButton(offer));
    }
  }

  // --- the Gentle AI question ---------------------------------------------

  // `gentle-ai version` answers with its own name and the number — "gentle-ai 3.6.1".
  // Gluing a "v" onto that whole answer is what produced "vgentle-ai 3.6.1": the number
  // is taken out of the answer and the "v" goes where a version's "v" goes.
  function versionTag(version) {
    var match = typeof version === "string" ? version.match(/\d+(?:\.\d+)+/) : null;
    if (match) {
      return " · v" + match[0];
    }
    return version ? " · " + version : "";
  }

  // `inQuestion` is the wizard's second step, where an already-active layer leaves
  // nothing to decide; the closing summary reuses the same reading without that tail.
  function gentleLine(gentle, inQuestion) {
    if (!gentle) {
      return "Leyendo el estado de Gentle AI…";
    }
    if (!gentle.installed && !gentle.active) {
      return "Gentle AI no está instalado.";
    }
    var version = versionTag(gentle.version);
    if (gentle.active) {
      var settled = inQuestion ? ". No hay nada que decidir." : ".";
      return "Gentle AI ya está activo en esta sesión" + version + settled;
    }
    return (
      "Gentle AI está instalado, pero esta sesión todavía no cargó sus comandos" + version + "."
    );
  }

  function renderGentle() {
    elements.gentleCurrent.textContent = gentleLine(state.gentle, true);
  }

  // --- the closing summary ------------------------------------------------

  function renderSummary() {
    elements.summaryRuntime.textContent = runtimeLine(state.runtime);
    elements.summaryGentle.textContent = gentleLine(state.gentle);
  }

  // --- steps --------------------------------------------------------------

  function showStep(step) {
    state.step = step;
    elements.piSection.hidden = step !== "pi";
    elements.gentleSection.hidden = step !== "gentle";
    elements.themeSection.hidden = step !== "theme";
    elements.summarySection.hidden = step !== "summary";
    // The gallery is mounted here as well as on the first `themes` message, because the host
    // pushes that message at "ready" — before this step is ever shown — and a component that
    // is not mounted yet cannot be fed.
    if (step === "theme") {
      mountThemeGallery();
    }

    var order = ["pi", "gentle", "theme", "summary"];
    var current = order.indexOf(step);
    for (var index = 0; index < elements.stepTabs.length; index += 1) {
      var tab = elements.stepTabs[index];
      if (!tab) {
        continue;
      }
      tab.classList.toggle("active", index === current);
      tab.classList.toggle("done", index < current);
    }
  }

  // --- host messages ------------------------------------------------------

  function handleHostMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "state":
        state.runtime = message.runtime && typeof message.runtime === "object" ? message.runtime : null;
        state.gentle = message.gentle && typeof message.gentle === "object" ? message.gentle : null;
        if (typeof message.configuredPath === "string") {
          state.configuredPath = message.configuredPath;
        }
        if (state.mode === null && state.runtime) {
          state.mode = state.runtime.mode;
        }
        renderRuntime();
        renderGentle();
        renderSummary();
        showNotice("");
        break;
      case "instanceProfile":
        state.profile = message.profile && typeof message.profile === "object" ? message.profile : null;
        renderProfilePart();
        break;
      case "runtimeResult":
        elements.runtimeApply.disabled = false;
        showResult(elements.runtimeResult, message.ok, message.message);
        // The step moves on by itself only when it has nothing to say. While the profile part
        // is visible, the sentence and its two doors are what has to be read, so the automatic
        // advance waits for the step's own way forward to be pressed. Once the part is gone
        // this very branch is that way forward again, so nobody is left without one.
        if (message.ok && !profilePartVisible()) {
          showStep("gentle");
        }
        break;
      case "gentleResult":
        elements.gentleInstall.disabled = false;
        showResult(elements.gentleResult, message.ok, message.message);
        if (message.ok) {
          showStep("summary");
        }
        break;
      case "themes":
        // The step's own sentence first, then the rows the shared gallery draws.
        if (typeof message.stepText === "string") {
          showResult(elements.themeNote, null, message.stepText);
        }
        mountThemeGallery();
        themeGallery.feed(message);
        break;
      case "preview":
      case "applied":
        themeGallery.feed(message);
        break;
      case "completed":
        elements.finish.disabled = true;
        elements.finish.textContent = "Configuración guardada";
        break;
      case "error":
        showNotice(message.message);
        break;
      default:
        break;
    }
  }

  // --- the theme step's gallery -------------------------------------------

  /*
   * The gallery is the panel's own component, mounted compactly: one list, no descriptions,
   * six rows. Sharing it is what keeps a theme from looking one way in the wizard and another
   * way in the gallery, and the wizard neither knows how a theme is painted nor how it is
   * applied — it forwards messages and the host answers them.
   */
  var themeGallery = { feed: function () {}, setCurrent: function () {} };
  var themeGalleryMounted = false;

  function mountThemeGallery() {
    var api = globalThis.PiCodeThemeGallery;
    if (themeGalleryMounted || !api || !elements.themeRoot) {
      return;
    }
    themeGalleryMounted = true;
    api.mount(elements.themeRoot, { post: send, compact: true });
    themeGallery = api;
  }

  // --- wiring -------------------------------------------------------------

  elements.runtimeApply.addEventListener("click", function () {
    showResult(elements.runtimeResult, null, "");
    elements.runtimeApply.disabled = true;
    send({ type: "applyRuntime", mode: state.mode, path: elements.runtimePath.value });
  });

  // The pi step's way forward while it has something to say. It only moves between the
  // wizard's own steps: the editor already works with the pi in force, and trapping the owner
  // here would be a worse failure than the automatic advance being fixed.
  elements.profilePartContinue.addEventListener("click", function () {
    showStep("gentle");
  });

  // The theme step's way forward. Applying a theme does not move the step on by itself: the
  // owner may want to look at another one, and the button is the only exit either way — with
  // a theme applied or with the one he already had.
  elements.themeContinue.addEventListener("click", function () {
    showStep("summary");
  });

  elements.gentleInstall.addEventListener("click", function () {
    showResult(elements.gentleResult, null, "");
    elements.gentleInstall.disabled = true;
    send({ type: "installGentle" });
  });

  elements.gentleSkip.addEventListener("click", function () {
    send({ type: "skipGentle" });
  });

  elements.openChat.addEventListener("click", function () {
    send({ type: "open", target: "chat" });
  });

  elements.openSettings.addEventListener("click", function () {
    send({ type: "open", target: "settings" });
  });

  elements.openGentle.addEventListener("click", function () {
    send({ type: "open", target: "gentle" });
  });

  elements.finish.addEventListener("click", function () {
    send({ type: "finish" });
  });

  window.addEventListener("message", function (event) {
    handleHostMessage(event.data);
  });

  showStep("pi");
  send({ type: "ready" });
})();
