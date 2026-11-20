/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Color } from '../../../../../base/common/color.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { aiCustomizationManagementSectionRegistry } from '../../../chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { themeKind, ThemeKind, themeMatches } from './picodeSettingsData.js';
import '../../../chat/browser/aiCustomization/media/picodeSettings.css';
import '../../../chat/browser/aiCustomization/media/picodeThemes.css';

const $ = DOM.$;
const PAGE_SIZE = 24;

/** The colours a preview is painted with; the rest are mixed from them in CSS. */
interface PreviewPalette {
	readonly bg: string;
	readonly fg: string;
	readonly ln: string;
	/** keyword, string, comment, function */
	readonly a: readonly [string, string, string, string];
	readonly side?: string;
	readonly title?: string;
	readonly accent?: string;
}

/** A theme on Open VSX, as the connector's gallery search answers (`theme-gallery.ts`). */
interface GalleryItem {
	readonly id: string;
	readonly label: string;
	readonly publisher: string;
	readonly downloads: number;
	readonly version: string;
	readonly downloadUrl?: string;
	readonly variant: { readonly id: string; readonly label: string; readonly uiTheme?: string; readonly path: string };
	readonly uiTheme: 'dark' | 'light' | 'hc';
}

type Source = 'installed' | 'gallery';

function compactCount(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 1_000)}K`;
	}
	return String(value);
}

/**
 * The theme gallery of the Settings window: the installed themes and Open VSX's, each as a small
 * window painted in its own colours. Hovering an installed theme shows it on the whole editor and
 * leaving brings back the one in use; a click applies it. A gallery theme installs on click and is
 * applied once the editor lists it.
 */
class PicodeThemesPage extends Disposable {

	private readonly root: HTMLElement;
	private readonly grid: HTMLElement;
	private readonly more: HTMLElement;
	private readonly note: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly gridStore = this._register(new DisposableStore());

	private source: Source = 'installed';
	private filter: ThemeKind | 'all' = 'all';
	private query = '';
	private shown = PAGE_SIZE;
	private themes: readonly IWorkbenchColorTheme[] = [];
	private galleryItems: readonly GalleryItem[] | undefined;
	private galleryError: string | undefined;
	private galleryLoading = false;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private installing: string | undefined;
	/** The theme really in use; while a card is hovered the editor reports the previewed one instead. */
	private appliedId: string;
	private previewing = false;

	constructor(
		container: HTMLElement,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@ICommandService private readonly commandService: ICommandService,
		@IExtensionResourceLoaderService private readonly resourceLoader: IExtensionResourceLoaderService,
	) {
		super();
		this.appliedId = this.themeService.getColorTheme().settingsId;
		this.root = DOM.append(container, $('.picode-set-page.picode-themes-page'));
		const inner = DOM.append(this.root, $('.picode-set-page-inner.wide'));
		DOM.append(inner, $('h2.picode-set-title')).textContent = localize('picodeThemesTitle', "Themes");
		DOM.append(inner, $('p.picode-set-lead')).textContent = localize('picodeThemesLead', "Hover to preview, click to apply.");
		this.toolbar = DOM.append(inner, $('.picode-themes-toolbar'));
		this.note = DOM.append(inner, $('.picode-themes-note'));
		this.note.setAttribute('role', 'status');
		this.grid = DOM.append(inner, $('.picode-themes-grid'));
		this.more = DOM.append(inner, $('.picode-themes-more'));
		this._register({ dispose: () => { this.root.remove(); if (this.searchTimer) { clearTimeout(this.searchTimer); } } });
		this._register(this.themeService.onDidColorThemeChange(theme => {
			// A change made elsewhere (the General page, the command palette) is the new theme in use.
			if (!this.previewing) {
				this.appliedId = theme.settingsId;
				this.markCurrent();
			}
		}));

		this.renderToolbar();
		void this.loadInstalled();
	}

	private renderToolbar(): void {
		DOM.clearNode(this.toolbar);
		const tabs = DOM.append(this.toolbar, $('.picode-set-segmented.picode-themes-tabs'));
		tabs.setAttribute('role', 'tablist');
		const pill = DOM.append(tabs, $('.picode-set-segmented-pill'));
		const sources: { id: Source; label: string; icon: typeof Codicon.check }[] = [
			{ id: 'installed', label: localize('picodeThemesInstalled', "Installed"), icon: Codicon.check },
			{ id: 'gallery', label: localize('picodeThemesGallery', "Gallery"), icon: Codicon.globe },
		];
		const buttons = sources.map(source => {
			const button = DOM.append(tabs, $('button.picode-set-segment')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-checked', String(source.id === this.source));
			button.appendChild(renderIcon(source.icon));
			DOM.append(button, $('span')).textContent = source.label;
			this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
				if (this.source !== source.id) {
					this.source = source.id;
					this.shown = PAGE_SIZE;
					this.renderToolbar();
					this.paint();
				}
			}));
			return button;
		});
		DOM.getWindow(tabs).requestAnimationFrame(() => {
			const chosen = buttons[sources.findIndex(s => s.id === this.source)];
			pill.style.width = `${chosen.offsetWidth}px`;
			pill.style.transform = `translateX(${chosen.offsetLeft}px)`;
			tabs.classList.add('ready');
		});

		const search = DOM.append(this.toolbar, $('.picode-settings-search.picode-themes-search'));
		search.appendChild(renderIcon(Codicon.search));
		const input = DOM.append(search, $('input')) as HTMLInputElement;
		input.type = 'search';
		input.value = this.query;
		input.placeholder = this.source === 'installed'
			? localize('picodeThemesSearchInstalled', "Search installed themes")
			: localize('picodeThemesSearchGallery', "Search Open VSX");
		input.setAttribute('aria-label', input.placeholder);
		this._register(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => {
			this.query = input.value;
			this.shown = PAGE_SIZE;
			if (this.source === 'installed') {
				this.paint();
				return;
			}
			// One gallery request per pause, not per keystroke.
			if (this.searchTimer) {
				clearTimeout(this.searchTimer);
			}
			this.searchTimer = setTimeout(() => { this.searchTimer = undefined; void this.loadGallery(); }, 350);
		}));

		const chips = DOM.append(this.toolbar, $('.picode-themes-filters'));
		const kinds: { id: ThemeKind | 'all'; label: string }[] = [
			{ id: 'all', label: localize('picodeThemesAll', "All") },
			{ id: 'dark', label: localize('picodePrefThemeDark', "Dark") },
			{ id: 'light', label: localize('picodePrefThemeLight', "Light") },
			{ id: 'hc', label: localize('picodeThemesHighContrast', "High contrast") },
		];
		for (const kind of kinds) {
			const chip = DOM.append(chips, $('button.picode-themes-chip')) as HTMLButtonElement;
			chip.type = 'button';
			chip.textContent = kind.label;
			chip.setAttribute('aria-pressed', String(kind.id === this.filter));
			this._register(DOM.addDisposableListener(chip, DOM.EventType.CLICK, () => {
				this.filter = kind.id;
				this.shown = PAGE_SIZE;
				chips.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === chip)));
				this.paint();
			}));
		}
	}

	private async loadInstalled(): Promise<void> {
		this.themes = await this.themeService.getColorThemes();
		this.paint();
	}

	private async loadGallery(): Promise<void> {
		this.galleryLoading = true;
		this.galleryError = undefined;
		this.paint();
		try {
			const answer = await this.commandService.executeCommand<{ items: GalleryItem[] }>('picode.setup.gallerySearch', this.query);
			this.galleryItems = answer?.items ?? [];
		} catch {
			// With AI turned off the connector is not running and the gallery cannot be asked.
			this.galleryItems = [];
			this.galleryError = localize('picodeThemesGalleryUnavailable', "The gallery can't be reached right now. Check your connection and try again.");
		}
		this.galleryLoading = false;
		this.paint();
	}

	private paint(): void {
		this.gridStore.clear();
		DOM.clearNode(this.grid);
		DOM.clearNode(this.more);
		if (this.source === 'installed') {
			this.paintInstalled();
		} else if (this.galleryItems === undefined && !this.galleryLoading) {
			void this.loadGallery();
		} else {
			this.paintGallery();
		}
	}

	private paintInstalled(): void {
		const visible = this.themes.filter(theme => themeMatches(this.query, this.filter, theme.label, themeKind(theme.type)));
		if (visible.length === 0) {
			this.empty(localize('picodeThemesNoneInstalled', "No installed theme matches. Try the gallery."));
			return;
		}
		for (const theme of visible.slice(0, this.shown)) {
			const card = this.card(theme.label, theme.extensionData?.extensionPublisher ?? localize('picodeThemesBuiltIn', "Built-in"), theme.settingsId);
			const preview = card.querySelector<HTMLElement>('.picode-theme-preview')!;
			void this.paintInstalledPreview(preview, theme);
			const restore = async () => {
				const current = this.themes.find(t => t.settingsId === this.appliedId);
				if (current) {
					await this.themeService.setColorTheme(current, 'preview');
				}
				this.previewing = false;
			};
			this.gridStore.add(DOM.addDisposableListener(card, DOM.EventType.MOUSE_ENTER, () => {
				this.previewing = true;
				void this.themeService.setColorTheme(theme, 'preview');
			}));
			this.gridStore.add(DOM.addDisposableListener(card, DOM.EventType.MOUSE_LEAVE, () => void restore()));
			// The theme object, never its settingsId: a string that is not a registry id applies nothing.
			this.gridStore.add(DOM.addDisposableListener(card, DOM.EventType.CLICK, async () => {
				this.appliedId = theme.settingsId;
				this.previewing = false;
				await this.themeService.setColorTheme(theme, 'auto');
				this.markCurrent();
			}));
		}
		this.markCurrent();
		this.showMore(visible.length);
	}

	private paintGallery(): void {
		if (this.galleryLoading) {
			for (let i = 0; i < 8; i++) {
				DOM.append(this.grid, $('.picode-theme-card.skeleton'));
			}
			return;
		}
		if (this.galleryError) {
			this.empty(this.galleryError, true);
			return;
		}
		const visible = (this.galleryItems ?? []).filter(item => themeMatches('', this.filter, item.variant.label, item.uiTheme));
		if (visible.length === 0) {
			this.empty(localize('picodeThemesNoneGallery', "Nothing found on Open VSX for that search."));
			return;
		}
		for (const item of visible.slice(0, this.shown)) {
			const installed = this.themes.some(theme => theme.label === item.variant.label);
			const card = this.card(item.variant.label, `${item.publisher} · ${compactCount(item.downloads)}`, undefined);
			const preview = card.querySelector<HTMLElement>('.picode-theme-preview')!;
			const action = DOM.append(card.querySelector('.picode-theme-meta')!, $('span.picode-theme-action'));
			action.textContent = installed ? localize('picodeThemesInstalledTag', "Installed") : localize('picodeThemesInstall', "Install");
			action.classList.toggle('done', installed);
			void this.paintGalleryPreview(preview, item);
			this.gridStore.add(DOM.addDisposableListener(card, DOM.EventType.CLICK, () => void this.install(item, card, action)));
		}
		this.showMore(visible.length);
	}

	private card(label: string, detail: string, settingsId: string | undefined): HTMLElement {
		const card = DOM.append(this.grid, $('button.picode-theme-card')) as HTMLButtonElement;
		card.type = 'button';
		card.title = label;
		if (settingsId) {
			card.dataset.themeId = settingsId;
		}
		const preview = DOM.append(card, $('.picode-theme-preview'));
		DOM.append(preview, $('.picode-theme-check')).appendChild(renderIcon(Codicon.check));
		const meta = DOM.append(card, $('.picode-theme-meta'));
		const text = DOM.append(meta, $('.picode-theme-text'));
		DOM.append(text, $('span.picode-theme-name')).textContent = label;
		DOM.append(text, $('span.picode-theme-detail')).textContent = detail;
		return card;
	}

	private empty(message: string, error = false): void {
		const el = DOM.append(this.grid, $('.picode-themes-empty'));
		el.classList.toggle('error', error);
		el.textContent = message;
		if (error) {
			const retry = DOM.append(el, $('button.picode-set-button')) as HTMLButtonElement;
			retry.type = 'button';
			retry.textContent = localize('picodeThemesRetry', "Try again");
			this.gridStore.add(DOM.addDisposableListener(retry, DOM.EventType.CLICK, () => void this.loadGallery()));
		}
	}

	private showMore(total: number): void {
		if (total <= this.shown) {
			return;
		}
		const button = DOM.append(this.more, $('button.picode-set-button')) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = localize('picodeThemesShowMore', "Show more");
		this.gridStore.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => { this.shown += PAGE_SIZE; this.paint(); }));
	}

	/** Lights the card of the theme in use. */
	private markCurrent(): void {
		const current = this.appliedId;
		this.grid.querySelectorAll<HTMLElement>('.picode-theme-card[data-theme-id]').forEach(card => {
			const on = card.dataset.themeId === current;
			card.classList.toggle('current', on);
			card.setAttribute('aria-pressed', String(on));
		});
	}

	private async install(item: GalleryItem, card: HTMLElement, action: HTMLElement): Promise<void> {
		if (this.installing) {
			return;
		}
		this.installing = item.id;
		card.classList.add('busy');
		action.textContent = localize('picodeThemesInstalling', "Installing…");
		try {
			await this.commandService.executeCommand('picode.setup.galleryInstall', item.id);
			// Installed is not yet listed: the editor's theme list catches up a moment later.
			let found: IWorkbenchColorTheme | undefined;
			for (let attempt = 0; attempt < 10 && !found; attempt++) {
				this.themes = await this.themeService.getColorThemes();
				found = this.themes.find(theme => theme.settingsId === item.variant.id || theme.label === item.variant.label);
				if (!found) {
					await new Promise<void>(resolve => setTimeout(resolve, 300));
				}
			}
			if (found) {
				this.appliedId = found.settingsId;
				await this.themeService.setColorTheme(found, 'auto');
				action.textContent = localize('picodeThemesApplied', "Applied");
				action.classList.add('done');
				this.note.textContent = '';
			} else {
				action.textContent = localize('picodeThemesInstalledTag', "Installed");
				this.note.textContent = localize('picodeThemesNotListed', "{0} is installed. It will appear under Installed in a moment.", item.variant.label);
			}
		} catch {
			action.textContent = localize('picodeThemesInstall', "Install");
			this.note.textContent = localize('picodeThemesInstallFailed', "{0} couldn't be installed. Try again.", item.variant.label);
		}
		card.classList.remove('busy');
		this.installing = undefined;
	}

	private async paintInstalledPreview(preview: HTMLElement, theme: IWorkbenchColorTheme): Promise<void> {
		const data = theme as ColorThemeData;
		try {
			await data.ensureLoaded(this.resourceLoader);
		} catch {
			return; // the neutral placeholder stays: never a wrong colour shown as the theme's
		}
		if (!preview.isConnected) {
			return;
		}
		const color = (id: string) => data.getColor(id)?.toString();
		const fg = color('editor.foreground') ?? '#cccccc';
		paintPreview(preview, {
			bg: color('editor.background') ?? '#1e1e1e',
			fg,
			ln: color('editorLineNumber.foreground') ?? '#6e7681',
			a: accentColors(data, fg),
			side: color('sideBar.background'),
			title: color('titleBar.activeBackground'),
			accent: color('button.background') ?? color('focusBorder'),
		});
	}

	private async paintGalleryPreview(preview: HTMLElement, item: GalleryItem): Promise<void> {
		try {
			const palette = await this.commandService.executeCommand<PreviewPalette>('picode.setup.galleryThumb', {
				id: item.id, version: item.version, downloadUrl: item.downloadUrl, declared: item.variant,
			});
			if (palette && preview.isConnected) {
				paintPreview(preview, palette);
			}
		} catch {
			// The placeholder stays.
		}
	}
}

/** Keyword, string, comment and function colours from the theme's own token rules. */
function accentColors(data: ColorThemeData, fallback: string): readonly [string, string, string, string] {
	const scopes = ['keyword', 'string', 'comment', 'entity.name.function'];
	const found: string[] = [fallback, fallback, fallback, fallback];
	for (const rule of data.tokenColors ?? []) {
		const foreground = rule.settings?.foreground;
		if (typeof foreground !== 'string') {
			continue;
		}
		const ruleScopes = typeof rule.scope === 'string' ? rule.scope.split(',').map(s => s.trim()) : Array.isArray(rule.scope) ? rule.scope : [];
		scopes.forEach((scope, index) => {
			if (found[index] === fallback && ruleScopes.some(s => s.includes(scope))) {
				const parsed = Color.Format.CSS.parseHex(foreground);
				if (parsed) {
					found[index] = Color.Format.CSS.formatHexA(parsed, true);
				}
			}
		});
	}
	return [found[0], found[1], found[2], found[3]];
}

/** A small window in the theme's colours: title bar, side bar with files, and code. */
function paintPreview(preview: HTMLElement, palette: PreviewPalette): void {
	const style = preview.style;
	style.setProperty('--tp-bg', palette.bg);
	style.setProperty('--tp-fg', palette.fg);
	style.setProperty('--tp-ln', palette.ln);
	style.setProperty('--tp-side', palette.side ?? `color-mix(in srgb, ${palette.bg} 88%, ${palette.fg})`);
	style.setProperty('--tp-title', palette.title ?? `color-mix(in srgb, ${palette.bg} 80%, #000)`);
	style.setProperty('--tp-accent', palette.accent ?? palette.a[3]);
	const check = preview.querySelector('.picode-theme-check');
	DOM.clearNode(preview);
	if (check) {
		preview.appendChild(check);
	}
	const title = DOM.append(preview, $('.tp-title'));
	for (let i = 0; i < 3; i++) {
		DOM.append(title, $('span.tp-dot'));
	}
	const body = DOM.append(preview, $('.tp-body'));
	const side = DOM.append(body, $('.tp-side'));
	for (const width of [70, 55, 80, 45]) {
		DOM.append(side, $('span.tp-file')).style.width = `${width}%`;
	}
	const code = DOM.append(body, $('.tp-code'));
	const k = palette.a[0], s = palette.a[1], c = palette.a[2], f = palette.a[3], fg = palette.fg;
	const lines: [string, string][][] = [
		[['const ', k], ['theme ', fg], ['= ', fg], ['pick', f], ['();', fg]],
		[['// looks good', c]],
		[['return ', k], ['"PiCode"', s], [';', fg]],
		[['if ', k], ['(dark) ', fg], ['apply', f], ['()', fg]],
	];
	lines.forEach((tokens, index) => {
		const line = DOM.append(code, $('.tp-line'));
		DOM.append(line, $('span.tp-ln')).textContent = String(index + 1);
		for (const [text, color] of tokens) {
			const span = DOM.append(line, $('span'));
			span.textContent = text;
			span.style.color = color;
		}
	});
	preview.classList.add('painted');
}

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.Themes,
	label: localize('picodeThemesTitle', "Themes"),
	icon: Codicon.symbolColor,
	description: localize('picodeThemesDescription', "Pick a color theme, or find one on Open VSX."),
	keywords: ['theme', 'color', 'dark', 'light', 'gallery', 'open vsx'],
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(PicodeThemesPage, container),
});
