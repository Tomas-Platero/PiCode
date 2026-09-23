/*
 * The preview of an editor theme, computed from the theme's own JSON.
 *
 * The owner asked to choose a theme from the catalogue `vscodethemes.com` previews, and
 * the honest way to show one is to paint the theme's own colours rather than to ship
 * somebody else's screenshot: the JSON *is* the theme, so a preview built from it stays
 * true when the theme updates, works with no network once the file is local, and needs no
 * licence to redistribute.
 *
 * Two things make a preview look like the editor rather than like a palette:
 *
 * - **Colour arithmetic, not string concatenation.** Themes write `#rgb`, `#rrggbb` and
 *   `#rrggbbaa`, and the translucent ones are not decoration: `editor.selectionBackground`
 *   and half the sidebar states are alpha over whatever is behind them. Every colour is
 *   therefore read as RGBA, composited over the surface it actually sits on — a selection
 *   over the editor's background, a status bar's foreground over the status bar — and only
 *   then turned into the `#rrggbb` the renderer receives. A theme that declares five
 *   colours still previews, because every frame token has a fallback derived from the two
 *   that matter.
 * - **A TextMate approximation, deliberately.** The sample's tokens carry scopes and the
 *   theme's `tokenColors` rules are matched against them by length of match, later rule
 *   winning a tie. It is not an editor's highlighter and it does not pretend to be; it is
 *   enough to tell two themes apart, which is the whole job of a preview.
 *
 * The module is pure: no I/O, no network, no editor. `theme-catalog.ts` reads the files
 * and the webview draws what this returns.
 */

import type {
  PreviewFrameToken,
  PreviewToken,
  ThemeJson,
  ThemePreview,
  ThemeTokenRule,
} from "./theme-types";

/* ------------------------------------------------------------------ *
 * Colour arithmetic
 * ------------------------------------------------------------------ */

interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1. */
  a: number;
}

/**
 * The editor's own default colours, which are what a theme that says nothing means.
 *
 * Dark is the pair that matters: VS Code's default theme is a dark one, and a theme file
 * with no `type` and no `include` is written over that default. The two pairs are the
 * editor's real defaults, not invented ones, so a preview of a nearly empty theme still
 * looks like the editor the owner is looking at.
 */
const DEFAULT_DARK = { background: "#1e1e1e", foreground: "#d4d4d4" } as const;
const DEFAULT_LIGHT = { background: "#ffffff", foreground: "#000000" } as const;

/**
 * A colour value as RGBA, or `undefined` when it is not one.
 *
 * Only the three forms a theme file may use are accepted: `#rgb`, `#rrggbb` and their
 * eight-digit alpha variants. Anything else (`"red"`, `"var(--x)"`, a half-written value)
 * is not guessed at — a wrong colour that looks plausible is worse in a preview than the
 * fallback, which at least says "this theme did not declare it".
 */
function parseColor(value: unknown): Rgba | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!/^#[0-9a-f]{3,8}$/i.test(text)) {
    return undefined;
  }
  const digits = text.slice(1).toLowerCase();
  if (digits.length === 3 || digits.length === 4) {
    const expanded = digits
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("");
    return parseColor(`#${expanded}`);
  }
  if (digits.length !== 6 && digits.length !== 8) {
    return undefined;
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
    a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
  };
}

/** The colour as `#rrggbb`. Alpha is gone by now: it was composited where it belonged. */
function toHex(color: Rgba): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** `over` painted on top of `under`, which is what a translucent theme colour means. */
function composite(over: Rgba, under: Rgba): Rgba {
  const alpha = over.a + under.a * (1 - over.a);
  if (alpha === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const blend = (top: number, bottom: number): number =>
    (top * over.a + bottom * under.a * (1 - over.a)) / alpha;
  return { r: blend(over.r, under.r), g: blend(over.g, under.g), b: blend(over.b, under.b), a: alpha };
}

/** `a` and `b` mixed, `weight` being how much of `b` ends up in the result. */
function mix(a: Rgba, b: Rgba, weight: number): Rgba {
  const clamp = Math.max(0, Math.min(1, weight));
  return {
    r: a.r + (b.r - a.r) * clamp,
    g: a.g + (b.g - a.g) * clamp,
    b: a.b + (b.b - a.b) * clamp,
    a: 1,
  };
}

/**
 * The first colour the theme declares among `keys`, composited over `surface`.
 *
 * Every lookup in this module goes through here, so "the theme declared it, but with
 * alpha" and "the theme declared nothing" cannot be told apart wrongly: the first is
 * composited, the second falls to the caller's own fallback.
 */
function colorOf(
  colors: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  surface: Rgba,
  fallback: Rgba,
): Rgba {
  for (const key of keys) {
    const parsed = parseColor(colors[key]);
    if (parsed !== undefined) {
      return parsed.a >= 1 ? parsed : composite(parsed, surface);
    }
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

/**
 * Whether the theme is dark.
 *
 * `type` is the theme's own answer and wins; `uiTheme` is the manifest's and is consulted
 * second, because a theme file may omit `type` while its manifest says `vs-dark`. `hc`
 * (the older high-contrast value) is dark, and with neither fact the answer is dark
 * because that is the editor's own default theme — the one this preview's fallbacks are
 * painted with.
 */
export function isDarkTheme(theme: ThemeJson, uiTheme?: string): boolean {
  const type = typeof theme.type === "string" ? theme.type.trim().toLowerCase() : "";
  if (type === "dark" || type === "hc" || type === "hc-black") {
    return true;
  }
  if (type === "light" || type === "hc-light") {
    return false;
  }
  const manifest = typeof uiTheme === "string" ? uiTheme.trim().toLowerCase() : "";
  if (manifest === "vs-dark" || manifest === "hc-black") {
    return true;
  }
  if (manifest === "vs" || manifest === "hc-light") {
    return false;
  }
  return true;
}

/** The frame's colours, in the order they depend on each other. */
function frameOf(theme: ThemeJson, dark: boolean): Record<PreviewFrameToken, string> {
  const colors: Readonly<Record<string, unknown>> =
    typeof theme.colors === "object" && theme.colors !== null ? theme.colors : {};
  const defaults = dark ? DEFAULT_DARK : DEFAULT_LIGHT;
  const fallbackBackground = parseColor(defaults.background) as Rgba;
  const fallbackForeground = parseColor(defaults.foreground) as Rgba;

  // Backgrounds first, each over the editor's, because a foreground can only be resolved
  // once the surface behind it exists.
  const editorBackground =
    colorOf(colors, ["editor.background"], fallbackBackground, fallbackBackground) ?? fallbackBackground;
  const tabActiveBackground = colorOf(
    colors,
    ["tab.activeBackground"],
    editorBackground,
    editorBackground,
  );
  const tabInactiveBackground = colorOf(
    colors,
    ["editorGroupHeader.tabsBackground"],
    editorBackground,
    mix(editorBackground, fallbackForeground, 0.06),
  );
  const sideBarBackground = colorOf(
    colors,
    ["sideBar.background"],
    editorBackground,
    mix(editorBackground, fallbackForeground, 0.04),
  );
  const statusBarBackground = colorOf(
    colors,
    ["statusBar.background"],
    editorBackground,
    mix(editorBackground, fallbackForeground, 0.12),
  );
  const activityBarBackground = colorOf(
    colors,
    ["activityBar.background"],
    editorBackground,
    sideBarBackground,
  );
  const titleBarBackground = colorOf(
    colors,
    ["titleBar.activeBackground"],
    editorBackground,
    mix(editorBackground, fallbackForeground, 0.08),
  );

  // Then every foreground, composited over the surface it actually sits on — and defaulting
  // to the theme's **own** editor foreground, not to the editor's default: a theme that
  // declares a text colour and nothing else means that colour everywhere, and falling back
  // to `#d4d4d4` would show a theme that does not exist.
  const editorForeground = colorOf(
    colors,
    ["editor.foreground"],
    editorBackground,
    fallbackForeground,
  );
  return {
    editorBackground: toHex(editorBackground),
    editorForeground: toHex(editorForeground),
    lineNumber: toHex(
      colorOf(
        colors,
        ["editorLineNumber.foreground"],
        editorBackground,
        mix(editorForeground, editorBackground, 0.45),
      ),
    ),
    tabActiveBackground: toHex(tabActiveBackground),
    tabActiveForeground: toHex(
      colorOf(colors, ["tab.activeForeground"], tabActiveBackground, editorForeground),
    ),
    tabInactiveBackground: toHex(tabInactiveBackground),
    sideBarBackground: toHex(sideBarBackground),
    sideBarForeground: toHex(
      colorOf(colors, ["sideBar.foreground"], sideBarBackground, editorForeground),
    ),
    statusBarBackground: toHex(statusBarBackground),
    statusBarForeground: toHex(
      colorOf(colors, ["statusBar.foreground"], statusBarBackground, editorForeground),
    ),
    titleBarBackground: toHex(titleBarBackground),
    activityBarBackground: toHex(activityBarBackground),
    border: toHex(
      colorOf(
        colors,
        ["panel.border", "editorGroup.border", "sideBar.border"],
        editorBackground,
        mix(editorBackground, editorForeground, 0.18),
      ),
    ),
    // A selection is drawn *over* code, so its alpha belongs to the editor's background —
    // this is the composition a theme's `#ffffff1a` is written for.
    selection: toHex(
      colorOf(
        colors,
        ["editor.selectionBackground", "list.activeSelectionBackground"],
        editorBackground,
        mix(editorBackground, editorForeground, 0.25),
      ),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * The sample
 * ------------------------------------------------------------------ */

/** One piece of the sample, with the scopes the theme's rules are matched against. */
export interface ScopedToken {
  text: string;
  /** TextMate scopes this piece has, most specific first. */
  scopes: readonly string[];
}

/** A line of the sample: tokens, which the renderer lays out in order. */
export type SampleLine = readonly ScopedToken[];

/*
 * The sample is fixed and short on purpose. It is not a file anyone will ever run: it is
 * the smallest piece of real-looking code that gives every scope a chance to appear —
 * comment, string, number, keyword, storage, type, class, function, parameter, property,
 * operator, punctuation — because a theme that colours ten of those differently must look
 * different from one that colours none of them. Every line stays inside 44 characters so
 * the preview fits the narrow panel it lives in.
 */
const SAMPLE: readonly SampleLine[] = [
  [{ text: "// the theme decides, not the sample", scopes: ["comment.line.double-slash"] }],
  [
    { text: "import", scopes: ["keyword.control.import"] },
    { text: " { ", scopes: ["punctuation.definition.block"] },
    { text: "readFile", scopes: ["variable.other.readwrite"] },
    { text: " } ", scopes: ["punctuation.definition.block"] },
    { text: "from", scopes: ["keyword.control.import.from"] },
    { text: " ", scopes: [] },
    { text: '"node:fs"', scopes: ["string.quoted.double"] },
    { text: ";", scopes: ["punctuation.terminator.statement"] },
  ],
  [],
  [
    { text: "const", scopes: ["storage.type"] },
    { text: " ", scopes: [] },
    { text: "RETRIES", scopes: ["variable.other.constant"] },
    { text: " = ", scopes: ["keyword.operator.assignment"] },
    { text: "3", scopes: ["constant.numeric"] },
    { text: ";", scopes: ["punctuation.terminator.statement"] },
  ],
  [
    { text: "type", scopes: ["storage.type"] },
    { text: " ", scopes: [] },
    { text: "Entry", scopes: ["entity.name.type.class"] },
    { text: " = { ", scopes: ["punctuation.definition.block"] },
    { text: "name", scopes: ["variable.other.property"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "string", scopes: ["support.type.primitive"] },
    { text: "; ", scopes: ["punctuation.terminator.statement"] },
    { text: "size", scopes: ["variable.other.property"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "number", scopes: ["support.type.primitive"] },
    { text: " }", scopes: ["punctuation.definition.block"] },
    { text: ";", scopes: ["punctuation.terminator.statement"] },
  ],
  [],
  [
    { text: "export", scopes: ["storage.modifier"] },
    { text: " ", scopes: [] },
    { text: "class", scopes: ["storage.type.class"] },
    { text: " ", scopes: [] },
    { text: "Catalogue", scopes: ["entity.name.class"] },
    { text: " {", scopes: ["punctuation.definition.block"] },
  ],
  [
    { text: "  private", scopes: ["storage.modifier"] },
    { text: " ", scopes: [] },
    { text: "readonly", scopes: ["storage.modifier"] },
    { text: " ", scopes: [] },
    { text: "entries", scopes: ["variable.other.property"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "Entry", scopes: ["entity.name.type.class"] },
    { text: "[] = [];", scopes: ["punctuation.definition.block"] },
  ],
  [],
  [
    { text: "  add", scopes: ["entity.name.function"] },
    { text: "(", scopes: ["punctuation.definition.parameters"] },
    { text: "name", scopes: ["variable.parameter"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "string", scopes: ["support.type.primitive"] },
    { text: ", ", scopes: ["punctuation.separator.parameters"] },
    { text: "size", scopes: ["variable.parameter"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "number", scopes: ["support.type.primitive"] },
    { text: ")", scopes: ["punctuation.definition.parameters"] },
    { text: ": ", scopes: ["punctuation.separator.key-value"] },
    { text: "void", scopes: ["support.type.primitive"] },
    { text: " {", scopes: ["punctuation.definition.block"] },
  ],
  [
    { text: "    if", scopes: ["keyword.control.conditional"] },
    { text: " (", scopes: ["punctuation.definition.group"] },
    { text: "name", scopes: ["variable.other.readwrite"] },
    { text: " === ", scopes: ["keyword.operator.comparison"] },
    { text: '""', scopes: ["string.quoted.double"] },
    { text: ")", scopes: ["punctuation.definition.group"] },
    { text: " throw", scopes: ["keyword.control.flow"] },
    { text: " new", scopes: ["keyword.operator.new"] },
    { text: " Error", scopes: ["support.class"] },
    { text: "(", scopes: ["punctuation.definition.group"] },
    { text: '"no"', scopes: ["string.quoted.double"] },
    { text: ");", scopes: ["punctuation.terminator.statement"] },
  ],
  [
    { text: "    this", scopes: ["variable.language.this"] },
    { text: ".", scopes: ["punctuation.separator.period"] },
    { text: "entries", scopes: ["variable.other.property"] },
    { text: ".", scopes: ["punctuation.separator.period"] },
    { text: "push", scopes: ["entity.name.function"] },
    { text: "({ ", scopes: ["punctuation.definition.block"] },
    { text: "name", scopes: ["variable.other.readwrite"] },
    { text: ", ", scopes: ["punctuation.separator.parameters"] },
    { text: "size", scopes: ["variable.other.readwrite"] },
    { text: " });", scopes: ["punctuation.definition.block"] },
  ],
  [{ text: "  }", scopes: ["punctuation.definition.block"] }],
  [{ text: "}", scopes: ["punctuation.definition.block"] }],
];

/** The sample the preview paints, as scoped tokens. Exported so it can be checked on its own. */
export function previewSample(): readonly SampleLine[] {
  return SAMPLE;
}

/* ------------------------------------------------------------------ *
 * Matching the theme's rules
 * ------------------------------------------------------------------ */

/** One selector, split into the parts a descendant selector is written with. */
interface Selector {
  /** True for a `-` selector: matching it takes the whole rule out of the running. */
  negative: boolean;
  parts: readonly string[];
}

/** Every selector a rule declares: the string form, its comma-separated list, or an array. */
function selectorsOf(rule: ThemeTokenRule): Selector[] {
  const raw = rule.scope;
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const selectors: Selector[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const piece of value.split(",")) {
      const text = piece.trim();
      if (text === "") {
        continue;
      }
      const negative = text.startsWith("-");
      const parts = (negative ? text.slice(1) : text)
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part !== "");
      if (parts.length > 0) {
        selectors.push({ negative, parts });
      }
    }
  }
  return selectors;
}

/** Whether a scope is the selector's own scope or a descendant of it. */
function scopeMatches(scope: string, part: string): boolean {
  return scope === part || scope.startsWith(`${part}.`);
}

/**
 * How specifically a selector matches a token, or `undefined` when it does not.
 *
 * The score is the length of the selector's own dotted parts — `keyword.control` scores 15
 * and `keyword` scores 7 — so the specific rule beats the general one, which is the whole
 * reason a theme ships both. A selector written with a space
 * (`meta.function entity.name.function`) is a descendant selector, and it is treated as
 * requiring every one of its parts, which is the closest thing to TextMate this preview
 * needs.
 */
function matchSpecificity(scopes: readonly string[], selector: Selector): number | undefined {
  let total = 0;
  for (const part of selector.parts) {
    if (!scopes.some((scope) => scopeMatches(scope, part))) {
      return undefined;
    }
    total += part.length;
  }
  return total;
}

interface MatchedStyle {
  foreground?: string;
  bold: boolean;
  italic: boolean;
}

/**
 * The style a token gets from the theme's rules.
 *
 * Every rule is considered in order; a rule with a matching negative selector is out, and
 * among the rest the longest match wins with a later rule taking a tie — which is the rule
 * VS Code applies to themes that ship a general rule and then refine it further down the
 * file. A rule that only sets `fontStyle` still wins its match: the colour then falls back
 * to the editor's foreground, exactly as it does in the editor.
 */
function styleForToken(
  rules: readonly ThemeTokenRule[],
  scopes: readonly string[],
  editorBackground: Rgba,
  editorForeground: Rgba,
): MatchedStyle {
  let best: MatchedStyle | undefined;
  let bestSpecificity = -1;
  for (const rule of rules) {
    // A theme file is data a stranger wrote: a `null` in the array is a rule to skip, not a
    // crash that would leave the preview blank.
    if (typeof rule !== "object" || rule === null) {
      continue;
    }
    const settings = rule.settings;
    if (typeof settings !== "object" || settings === null) {
      continue;
    }
    const selectors = selectorsOf(rule);
    if (selectors.some((selector) => selector.negative && selectorMatches(scopes, selector))) {
      continue;
    }
    const specificity = selectors.reduce<number | undefined>((winner, selector) => {
      if (selector.negative) {
        return winner;
      }
      const matched = matchSpecificity(scopes, selector);
      if (matched === undefined) {
        return winner;
      }
      return winner === undefined || matched > winner ? matched : winner;
    }, undefined);
    if (specificity === undefined || specificity < bestSpecificity) {
      continue;
    }
    const fontStyle = typeof settings.fontStyle === "string" ? settings.fontStyle : "";
    const foreground = parseColor(settings.foreground);
    bestSpecificity = specificity;
    best = {
      foreground:
        foreground === undefined
          ? undefined
          : toHex(foreground.a >= 1 ? foreground : composite(foreground, editorBackground)),
      bold: /bold/.test(fontStyle),
      italic: /italic/.test(fontStyle),
    };
  }
  return (
    best ?? {
      foreground: toHex(editorForeground),
      bold: false,
      italic: false,
    }
  );
}

/** Whether a negative selector matches, which takes its rule out of the running. */
function selectorMatches(scopes: readonly string[], selector: Selector): boolean {
  return matchSpecificity(scopes, selector) !== undefined;
}

/* ------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------ */

/** The preview: the frame's colours and the sample painted with the theme's own rules. */
export function previewFromTheme(theme: ThemeJson, uiTheme?: string): ThemePreview {
  const dark = isDarkTheme(theme, uiTheme);
  const frame = frameOf(theme, dark);
  const rules = Array.isArray(theme.tokenColors) ? theme.tokenColors : [];
  const editorBackground = parseColor(frame.editorBackground) as Rgba;
  const editorForeground = parseColor(frame.editorForeground) as Rgba;

  const lines = previewSample().map((line) =>
    line.map((token): PreviewToken => {
      const style = styleForToken(rules, token.scopes, editorBackground, editorForeground);
      const painted: PreviewToken = {
        text: token.text,
        color: style.foreground ?? frame.editorForeground,
      };
      if (style.bold) {
        painted.bold = true;
      }
      if (style.italic) {
        painted.italic = true;
      }
      return painted;
    }),
  );

  return { dark, frame, lines };
}
