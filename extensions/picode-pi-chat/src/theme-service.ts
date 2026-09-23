/*
 * What the theme surfaces ask of the editor: which themes there are, what one looks like,
 * and applying it.
 *
 * The three halves this sits between are deliberately narrow — `theme-catalog.ts` finds and
 * reads theme files, `theme-preview.ts` paints one, `theme-view.ts` draws — and this module
 * is the only place that touches the editor: the installed extensions, the gallery's
 * registry, the cache directory, `workbench.colorTheme` and the install command.
 *
 * Two decisions live here and nowhere else:
 *
 * - **Installed wins.** A theme the editor already has is read from its own directory and
 *   marked as installed, so the first rows of the gallery work with no network at all and a
 *   preview of an installed theme cannot disagree with what the owner is looking at.
 * - **The reload is offered only when it is needed.** Applying a theme that is installed is
 *   one settings write and takes effect at once; applying one that had to be *installed*
 *   first can reach the theme registry a moment too late, so the answer says whether the
 *   window needs reloading and the surface offers the button only then. It is the same rule
 *   the import's closing follows: a button exists where pressing it changes something.
 *
 * Everything the editor owns arrives as a parameter (`ThemeServiceDeps`), which is what lets
 * the suite exercise the whole thing — including the install-then-apply decision — without an
 * editor, and what keeps `vscode` out of the decisions.
 */

import {
  DEFAULT_REGISTRY_BASE,
  declaredThemes,
  loadVariant,
  registryApiBase,
  searchThemes,
  type DeclaredTheme,
  type ThemeCandidate,
} from "./theme-catalog";
import { previewFromTheme } from "./theme-preview";
import type { ThemePreview, ThemeVariant } from "./theme-types";

/** Where the site that previews themes lives. It is a viewer: it cannot install anything. */
export const VSCODETHEMES_URL = "https://vscodethemes.com/";

/** Which key of `product.json` names the gallery PiCode ships with. */
export const GALLERY_PRODUCT_KEY = "extensionsGallery";

/** One extension the editor has, reduced to what a theme row needs. */
export interface InstalledExtension {
  id: string;
  extensionPath: string;
  packageJSON: unknown;
}

/** The part of the editor's configuration this feature reads and writes. */
export interface ThemeConfiguration {
  /** The theme in force, or `undefined` when the editor is on its own default. */
  current(): string | undefined;
  /** Writes `workbench.colorTheme`. */
  apply(themeId: string): Promise<void>;
}

/** Everything the editor owns, injected. */
export interface ThemeServiceDeps {
  /** Every installed extension. Read again after an install, which is how the reload is decided. */
  installedExtensions(): readonly InstalledExtension[];
  configuration(): ThemeConfiguration;
  /** Installs one extension from the gallery. */
  install(extensionId: string): Promise<void>;
  /** The registry API base: the gallery's own host, when product.json could be read. */
  registryBase: string;
  /** Where a downloaded VSIX is kept between runs. */
  cacheDir?: string;
  fetchLike?: typeof fetch;
}

/** One theme as a row of the gallery shows it: the extension, and the themes it declares. */
export interface ThemeRow {
  /** `publisher.name` — what the editor installs. */
  id: string;
  displayName: string;
  description: string;
  downloads: number;
  version: string;
  iconUrl?: string;
  installed: boolean;
  themes: readonly DeclaredTheme[];
  /** Where to browse this theme on the site that previews them. */
  galleryUrl: string;
  /**
   * The VSIX a catalogue row can be read from. Internal: a row is shown by its name, and the
   * URL exists because reading a theme that is not installed yet means downloading its
   * package once. An installed row has no use for it.
   */
  downloadUrl?: string;
}

/** What one theme's preview is: the painted sample, or why it could not be read. */
export type ThemePreviewResult =
  | { ok: true; variant: { id: string; label: string; uiTheme?: string }; preview: ThemePreview }
  | { ok: false; reason: string };

/** What applying a theme did. */
export interface ApplyResult {
  /** True when the theme is in force. `false` means the row was not usable and nothing happened. */
  applied: boolean;
  /** True when the extension had to be installed for it. */
  installed: boolean;
  /** True when the editor does not know the theme yet, which is what a window reload fixes. */
  needsReload: boolean;
  /** The theme the editor reports afterwards, when it reports one. */
  current?: string;
}

/**
 * The registry base the product's own gallery points at.
 *
 * Read from `product.json` rather than written a second time: a build that shipped a
 * different gallery would then browse *that* host's registry, and a product that cannot be
 * read falls back to Open VSX — the gallery PiCode ships — instead of to nothing.
 */
export function registryBaseFrom(productJson: unknown): string {
  const product = typeof productJson === "object" && productJson !== null ? productJson : {};
  const gallery = (product as { extensionsGallery?: unknown }).extensionsGallery;
  const serviceUrl =
    typeof gallery === "object" && gallery !== null
      ? (gallery as { serviceUrl?: unknown }).serviceUrl
      : undefined;
  if (typeof serviceUrl !== "string") {
    return DEFAULT_REGISTRY_BASE;
  }
  return registryApiBase(serviceUrl) ?? DEFAULT_REGISTRY_BASE;
}

/** The site's search for one theme's name — the only URL of theirs that can be built blind. */
export function vscodethemesUrl(name: string): string {
  return `${VSCODETHEMES_URL}?q=${encodeURIComponent(name)}`;
}

/**
 * The themes the installed extensions declare, as rows.
 *
 * `contributes.themes` is read by the catalogue's own tolerant reader, so an installed row
 * and a catalogue row are the same shape and cannot start disagreeing about the same
 * extension. Extensions that declare no theme are left out — most of them are — and the
 * order is the editor's own, which puts the built-in defaults first: a theme the owner
 * already has is the likeliest thing he is looking for.
 */
export function installedThemeRows(extensions: readonly InstalledExtension[]): ThemeRow[] {
  const rows: ThemeRow[] = [];
  for (const extension of extensions) {
    const manifest =
      typeof extension.packageJSON === "object" && extension.packageJSON !== null
        ? (extension.packageJSON as Record<string, unknown>)
        : {};
    const themes = declaredThemes(extension.packageJSON);
    if (themes.length === 0) {
      continue;
    }
    const displayName =
      typeof manifest.displayName === "string" && manifest.displayName !== ""
        ? manifest.displayName
        : extension.id;
    const row: ThemeRow = {
      id: extension.id,
      displayName,
      description: typeof manifest.description === "string" ? manifest.description : "",
      downloads: 0,
      version: typeof manifest.version === "string" ? manifest.version : "",
      installed: true,
      themes,
      galleryUrl: vscodethemesUrl(displayName),
    };
    if (typeof manifest.icon === "string" && manifest.icon !== "") {
      // An installed extension's icon is a file inside it, which the gallery cannot fetch:
      // the row keeps no picture rather than a URL that would never load.
      rows.push(row);
    } else {
      rows.push(row);
    }
  }
  return rows;
}

/** A catalogue entry as a gallery row, with the editor's own state merged in. */
export function catalogueThemeRow(candidate: ThemeCandidate, installed: boolean): ThemeRow {
  const row: ThemeRow = {
    id: candidate.id,
    displayName: candidate.displayName,
    description: candidate.description,
    downloads: candidate.downloads,
    version: candidate.version,
    installed,
    themes: candidate.declared,
    galleryUrl: vscodethemesUrl(candidate.displayName === "" ? candidate.id : candidate.displayName),
    ...(candidate.iconUrl === undefined ? {} : { iconUrl: candidate.iconUrl }),
    ...(candidate.downloadUrl === undefined ? {} : { downloadUrl: candidate.downloadUrl }),
  };
  return row;
}

export interface ThemeService {
  /** The themes the editor already has. No network. */
  installed(): ThemeRow[];
  /** The gallery's themes, with the installed ones marked. */
  catalog(query: string): Promise<ThemeRow[]>;
  /** One theme, painted. */
  preview(row: ThemeRow, themeId: string): Promise<ThemePreviewResult>;
  /** One theme, in force; installs it first when the editor does not have it. */
  apply(row: ThemeRow, themeId: string): Promise<ApplyResult>;
  /** The theme in force, for the settings row. */
  current(): string | undefined;
}

/** The theme of a row the owner picked, falling back to its first one. */
function themeOf(row: ThemeRow, themeId: string): DeclaredTheme | undefined {
  return row.themes.find((theme) => theme.id === themeId) ?? row.themes[0];
}

/** The id of an extension the editor has, for the "is it installed" question. */
function installedIds(extensions: readonly InstalledExtension[]): Set<string> {
  return new Set(extensions.map((extension) => extension.id));
}

export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  const readOptions = {
    ...(deps.cacheDir === undefined ? {} : { cacheDir: deps.cacheDir }),
    ...(deps.fetchLike === undefined ? {} : { fetchLike: deps.fetchLike }),
  };

  /** One theme's file, from the installed extension or out of its package. */
  const variantOf = async (row: ThemeRow, themeId: string): Promise<ThemeVariant | undefined> => {
    const declared = themeOf(row, themeId);
    if (declared === undefined) {
      return undefined;
    }
    const extension = deps
      .installedExtensions()
      .find((candidate) => candidate.id === row.id);
    return loadVariant({
      extensionId: row.id,
      version: row.version,
      declared,
      ...(extension === undefined ? {} : { installedRoot: extension.extensionPath }),
      ...(row.downloadUrl === undefined ? {} : { downloadUrl: row.downloadUrl }),
      ...readOptions,
    });
  };

  return {
    installed(): ThemeRow[] {
      return installedThemeRows(deps.installedExtensions());
    },

    async catalog(query: string): Promise<ThemeRow[]> {
      const candidates = await searchThemes({
        base: deps.registryBase,
        query,
        ...(deps.fetchLike === undefined ? {} : { fetchLike: deps.fetchLike }),
      });
      const installed = installedIds(deps.installedExtensions());
      return candidates.map((candidate) => catalogueThemeRow(candidate, installed.has(candidate.id)));
    },

    async preview(row: ThemeRow, themeId: string): Promise<ThemePreviewResult> {
      const variant = await variantOf(row, themeId);
      if (variant === undefined) {
        const label = themeOf(row, themeId)?.label ?? themeId;
        return {
          ok: false,
          reason:
            `No se pudo leer el fichero del tema «${label}»: no está en la extensión instalada ` +
            "ni se pudo leer de su paquete.",
        };
      }
      const identity: { id: string; label: string; uiTheme?: string } = {
        id: variant.id,
        label: variant.label,
      };
      if (variant.uiTheme !== undefined) {
        identity.uiTheme = variant.uiTheme;
      }
      return {
        ok: true,
        variant: identity,
        preview: previewFromTheme(variant.theme, variant.uiTheme),
      };
    },

    async apply(row: ThemeRow, themeId: string): Promise<ApplyResult> {
      const declared = themeOf(row, themeId);
      if (declared === undefined) {
        return { applied: false, installed: false, needsReload: false };
      }
      const configuration = deps.configuration();
      const wasInstalled = installedIds(deps.installedExtensions()).has(row.id);
      if (!wasInstalled) {
        await deps.install(row.id);
      }
      await configuration.apply(declared.id);

      // What the editor knows *now*: an install that has landed puts the theme in the list,
      // and one that has not means the theme registry is a step behind the settings file.
      const known = installedThemeRows(deps.installedExtensions()).some((installedRow) =>
        installedRow.themes.some((theme) => theme.id === declared.id),
      );
      const current = configuration.current();
      return {
        applied: true,
        installed: !wasInstalled,
        needsReload: !wasInstalled && !known,
        ...(current === undefined ? {} : { current }),
      };
    },

    current(): string | undefined {
      return deps.configuration().current();
    },
  };
}
