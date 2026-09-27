/*
 * The shapes the theme feature passes between its three halves, in one file so they
 * cannot drift apart.
 *
 * The feature has three parts and they are deliberately separate:
 *
 * - `theme-catalog.ts` finds themes in the gallery PiCode installs from (Open VSX) and
 *   reads a theme's own JSON — from disk when the theme is installed, out of the VSIX when
 *   it is not — resolving the `include` chain each theme file may start with.
 * - `theme-preview.ts` turns that JSON into a preview: the colours of the editor frame,
 *   already resolved, and a fixed code sample with every token painted by the theme's own
 *   `tokenColors`.
 * - `theme-view.ts` draws the preview and applies the theme.
 *
 * The types live here rather than in one of the three because two of them would then have
 * to import the other, which is how a "catalogue" and a "renderer" end up needing each
 * other to compile.
 */

/* ------------------------------------------------------------------ *
 * pi's own theme file, as the extension ships it
 * ------------------------------------------------------------------ */

/**
 * One `tokenColors` rule, reduced to what a preview needs.
 *
 * A theme file's rules are TextMate scope selectors with a `settings` block of colours and
 * font styles. The selector can be a string (`"keyword.control"`), a comma-separated list
 * inside that string, or an array of them; all three appear in real themes.
 */
export interface ThemeTokenRule {
  scope?: string | readonly string[];
  settings?: {
    foreground?: string;
    fontStyle?: string;
  };
}

/**
 * A theme file as it is written, with `include` possibly unresolved.
 *
 * Only the four keys a preview uses are typed. Everything else a theme file carries —
 * `semanticHighlighting`, `name`, whatever a future pi adds — is kept by the merge and
 * ignored here, because this module does not own pi's schema for themes either.
 */
export interface ThemeJson {
  name?: string;
  type?: string;
  /** The base this theme is written over: another path in the same VSIX, or `"vscode"`. */
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: readonly ThemeTokenRule[];
}

/* ------------------------------------------------------------------ *
 * What the catalogue knows
 * ------------------------------------------------------------------ */

/** One theme a theme extension declares: what the owner picks. */
export interface ThemeVariant {
  /**
   * The value `workbench.colorTheme` takes. It is the manifest's own `id` when it declares
   * one, and the label otherwise — that is what the editor resolves, and inventing our own
   * identifier would set a value the editor does not know.
   */
  id: string;
  label: string;
  /** The manifest's `uiTheme`: `vs-dark`, `vs`, `hc-black` or `hc-light`. */
  uiTheme?: string;
  /** Where the file is, for a reader: an absolute path, or the path inside the VSIX. Never shown. */
  path: string;
  /** The theme file with its `include` chain already merged over it. */
  theme: ThemeJson;
}

/** One theme extension, as the gallery shows it. */
export interface CatalogTheme {
  /** `publisher.name` — the id the editor installs and the VSIX is read from. */
  id: string;
  displayName: string;
  description: string;
  /** `downloadCount`, the only popularity signal the registry publishes. */
  downloads: number;
  version: string;
  /** The extension's icon, when it declares one. Shown as the row's picture. */
  iconUrl?: string;
  /** True when the editor already has this extension. */
  installed: boolean;
  /** Its themes, in the order the manifest declares them. Empty until the theme files are read. */
  variants: readonly ThemeVariant[];
}

/* ------------------------------------------------------------------ *
 * What the preview needs
 * ------------------------------------------------------------------ */

/**
 * The parts of the editor frame a preview draws, as our own names.
 *
 * They are not the theme's keys: which theme key feeds each one is the resolver's business
 * (`theme-preview.ts`), and naming them after the theme would spread a theme's vocabulary
 * across the renderer. Every one of them has a fallback, because a theme is free to declare
 * a handful of colours and inherit the rest.
 */
export type PreviewFrameToken =
  | "editorBackground"
  | "editorForeground"
  | "lineNumber"
  | "tabActiveBackground"
  | "tabActiveForeground"
  | "tabInactiveBackground"
  | "sideBarBackground"
  | "sideBarForeground"
  | "statusBarBackground"
  | "statusBarForeground"
  | "titleBarBackground"
  | "activityBarBackground"
  | "border"
  | "selection";

/** One painted piece of the sample: its text and the colour the theme gives it. */
export interface PreviewToken {
  text: string;
  /** A `#rrggbb` colour, always resolved: the fallback is applied by the resolver, not the renderer. */
  color: string;
  bold?: boolean;
  italic?: boolean;
}

/** The whole preview: the frame's colours and the sample, split into lines. */
export interface ThemePreview {
  /** True when the theme is dark, which the renderer uses for its own chrome and labels. */
  dark: boolean;
  frame: Readonly<Record<PreviewFrameToken, string>>;
  lines: readonly (readonly PreviewToken[])[];
}
