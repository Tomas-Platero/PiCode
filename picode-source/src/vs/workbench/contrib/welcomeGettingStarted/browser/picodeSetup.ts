/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, $, reset, clearNode } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colors/editorColors.js';
import { editorLineNumbers } from '../../../../editor/common/core/editorColorRegistry.js';
import { Color } from '../../../../base/common/color.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { ColorThemeData } from '../../../services/themes/common/colorThemeData.js';

/**
 * The PiCode setup, as **cards on the welcome page**.
 *
 * The page owns the questions; this module owns the rendering and the calls. Four cards:
 *
 * - **Sign in** — the first step: the PiCode Account state as the authentication service
 *   sees it, the provider's own browser sign-in behind one button, and the pricing line
 *   for the Pro plan the sync needs.
 * - **pi** — two option cards with live facts (the internal pi's version; the machine's pi
 *   probed once for path and version). Choosing one applies it and the note under the cards
 *   says what the choice loads. When the internal pi runs and the machine's profile holds
 *   anything, a "Import from my external pi" action appears with the **counts first** and a
 *   confirm behind them — nothing is ever imported silently.
 * - **Gentle AI** — asked about only while the internal pi runs (it lives in PiCode's own
 *   profile). Three states: not installed, working (inline, no popups), installed with its
 *   version and update/remove.
 * - **pi packages** — the theme's two-source pattern again: what pi already has installed
 *   (read-only rows) and npm's catalog of pi packages, searched with a pause, paged, and
 *   installed on click. The step is optional by nature: moving past it changes nothing.
 * - **Theme** — a gallery grid: one card per installed theme, a small preview painted from
 *   the theme's own loaded colors, search and a Dark/Light/High-contrast filter, the active
 *   theme marked, and **live preview on hover**: the theme is applied with the editor's
 *   preview target while the pointer or the focus is on the card, and restored on leave.
 *   Theme data is loaded lazily, page by page, so opening the welcome never pays for every
 *   theme on disk.
 *
 * Everything here talks to the connector through commands (`picode.setup.*`) and to the
 * editor through its theme service; no webview, no popups, no new dependencies.
 */

/** How many gallery cards show before "Show more" offers the next page. */
const THEME_GALLERY_PAGE = 24;

/** How many package rows show before "Show more" offers the next page. */
const PACKAGE_GALLERY_PAGE = 24;

/** The authentication provider id of the PiCode Account, as the accounts menu shows it. */
const PICODE_AUTH_PROVIDER_ID = 'picode';

/** The scopes the setup asks for: the same `sync` scope the Settings Sync engine uses. */
const PICODE_AUTH_SCOPES = ['sync'];

/** The pricing page, where the Pro plan the sync needs is described. */
const PICODE_PRICING_URL = 'https://www.getpicode.app/pricing';

/** Asks the authentication service for the PiCode Account state. */
const PICODE_ACCOUNT_STATE_COMMAND = 'picode.setup.accountState';

/** Runs the PiCode Account sign-in (the provider's own browser flow). */
const PICODE_SIGN_IN_COMMAND = 'picode.setup.accountSignIn';

/** What the account commands answer with: whether a session exists, and who for. */
interface AccountStatus {
	readonly signedIn: boolean;
	/** The account label — the email the PiCode Account is signed in with. */
	readonly label?: string;
	/** The account avatar, when the sign-in provider returned one. */
	readonly avatar?: string;
}

/** One model of the fetched list, as the connector's modelsList answers it. */
interface WizardModel {
	ref: string;
	provider: string;
	model: string;
}

/** One row of the gallery (Open VSX), as the connector's search answers it. */
interface GalleryItem {
	id: string;
	label: string;
	publisher: string;
	downloads: number;
	version: string;
	downloadUrl?: string;
	variant: { label: string; path?: string; uiTheme?: string; id?: string };
	uiTheme: 'dark' | 'light' | 'hc';
}

/** The thumbnail palette, computed from the theme's own file by the connector. */
interface GalleryPalette {
	bg: string;
	fg: string;
	ln: string;
	a: readonly [string, string, string, string];
}

/** One installed pi package, as the connector's `picode.setup.packages` answers it. */
interface InstalledPackage {
	id: string;
	name: string;
	version?: string;
	description?: string;
	/** The declaration as the settings file spells it (`npm:some-package`). */
	source?: string;
	state?: 'enabled' | 'disabled';
}

/** One row of npm's catalog, as the connector's `picode.packages.search` answers it. */
interface CatalogPackage {
	name: string;
	description?: string;
	publisher?: string;
	version?: string;
}

/** What the connector's install answers: whether it worked, and the one sentence to show. */
interface PackageInstallResult {
	ok: boolean;
	message: string;
}

/** The facts the connector answers with (`picode.setup.getState`). */
interface SetupState {
	runtime: 'internal' | 'external';
	externalAvailable: boolean;
	gentleInstalled: boolean;
	internalPiVersion?: string;
	gentleVersion?: string;
}

/** What the probe answers about the machine's pi. */
interface ExternalPiInfo {
	found: boolean;
	path?: string;
	version?: string;
}

/** What the import preview counts, read-only, from the machine's profile. */
interface ProfilePreview {
	exists: boolean;
	packages: number;
	providers: number;
	mcpServers: number;
	skills: number;
	sessions: number;
	hasCredentials: boolean;
	profile: string;
}

/** What one import copied, item by item folded into counts. */
interface ImportReport {
	copied: number;
	overwritten: number;
	absent: number;
	declined: number;
	failed: number;
	/** The declared packages the connector installed into this profile after the copy. */
	packagesInstalled?: number;
	packagesFailed?: number;
}

export interface PiCodeSetupServices {
	readonly commandService: ICommandService;
	readonly themeService: IWorkbenchThemeService;
	readonly extensionResourceLoaderService: IExtensionResourceLoaderService;
}

/** How many theme cards render before the "Show more" button offers the next page. */
const THEME_PAGE_SIZE = 24;

export class PiCodeSetup extends Disposable {

	private state: SetupState | undefined;
	private themes: readonly IWorkbenchColorTheme[] | undefined;
	/** The settingsId the theme service should go back to when a preview ends. */
	private appliedThemeId: string | undefined;
	/** True while an action runs, so a second click cannot start it twice. */
	private busy = false;

	/* The wizard: which step is on screen, and what the owner has done in it. */
	private step: 0 | 1 | 2 | 3 | 4 | 5 = 0;
	/** The PiCode Account state, asked once and repainted when the sign-in lands. */
	private accountStatus: AccountStatus | undefined;
	/** Step 1's Next stays disabled until an option card is clicked at least once. */
	private piChosen = false;
	/** The wizard ran to the end. */
	private finished = false;
	/** The owner chose "Not now": the whole setup steps aside until reopened. */
	private skipped = false;
	/** The default model the owner picked in the provider step (provider/model). */
	private wizardModel: string | undefined;
	/** The model list fetched from the provider(s), for the picker and the agents. */
	private wizardModels: WizardModel[] | undefined;
	private modelsLoading = false;
	/** Gentle AI's agent names, fetched after the install. */
	private gentleAgents: string[] | undefined;
	/** The owner's per-agent model choices. */
	private agentProfiles: Record<string, string> = {};
	private readonly disposables = this._register(new DisposableStore());
	/** The grid's own store: repainting the grid must not unbind the rest of the cards. */
	private readonly gridDisposables = this._register(new DisposableStore());

	// Live elements, re-created on every render.
	private importResult: HTMLElement | undefined;
	/** True from the click that starts the import until its report lands. */
	private importRunning = false;
	/** The finished import's counts, kept across re-renders. */
	private importReport: (ImportReport & { packagesInstalled?: number; packagesFailed?: number; packagesSkipped?: number; credentialsImported?: boolean }) | undefined;
	private note: HTMLElement | undefined;
	/** The final screen's one-line ending, set once "End the setup" answers. */
	private endedNote: string | undefined;
	private endedWithError = false;
	private gentleStatus: HTMLElement | undefined;
	/* The theme card's two sources: what is installed, and what the gallery (Open VSX) has. */
	private themeSource: 'installed' | 'gallery' = 'installed';
	private galleryItems: GalleryItem[] | undefined;
	private galleryQuery = '';
	private galleryShown = 0;
	private galleryLoading = false;
	private gallerySearchTimer: Timeout | undefined;
	/* The packages card's two sources: what pi has installed, and what npm's catalog has. */
	private packageSource: 'installed' | 'gallery' = 'installed';
	private installedPackages: InstalledPackage[] | undefined;
	private packageCatalog: CatalogPackage[] | undefined;
	private packageQuery = '';
	private packagesShown = PACKAGE_GALLERY_PAGE;
	private packagesLoading = false;
	private packagesError = '';
	/** The catalog row an install is running for; one install at a time, like pi's own queue. */
	private installingPackage: string | undefined;
	private packageSearchTimer: Timeout | undefined;
	/** The Gentle installer's live output, polled while the install runs. */
	private gentleLogEl: HTMLElement | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly services: PiCodeSetupServices,
	) {
		super();
		this.appliedThemeId = this.services.themeService.getColorTheme().settingsId;
	}

	/** Fetches the state and paints the three cards; safe to call again after an action. */
	async render(): Promise<void> {
		const [state] = await Promise.all([this.resolveState(), this.resolveThemes()]);
		if (this._store.isDisposed) { return; }
		this.state = state;
		this.renderWizard(state);
	}

	private async resolveState(): Promise<SetupState | undefined> {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				return await this.services.commandService.executeCommand<SetupState>('picode.setup.getState');
			} catch {
				// The connector activates as the window finishes starting; give it a moment.
				await new Promise<void>(resolve => setTimeout(resolve, 1500));
			}
		}
		return undefined;
	}

	private async resolveThemes(): Promise<void> {
		if (!this.themes) {
			this.themes = await this.services.themeService.getColorThemes();
		}
	}

	/* ------------------------------------------------------------------ *
	 * The cards
	 * ------------------------------------------------------------------ */

	private renderWizard(state: SetupState | undefined): void {
		this.disposables.clear();
		clearNode(this.container);

		if (state === undefined) {
			const note = $('p.picode-note', {}, localize('picodeSetup.unavailable', "The setup is not available yet — it will appear in a moment."));
			reset(this.container as HTMLElement, note);
			return;
		}
		if (this.skipped) {
			reset(this.container as HTMLElement, $('.picode-card', {},
				$('p', {}, localize('picodeSetup.skipped', "Setup skipped. Reopen it any time: run 'PiCode: Set up PiCode' from the command palette, or Help > Welcome.")),
				$('.picode-gentle-actions', {},
					this.button('picode-setup-reopen', localize('picodeSetup.reopen', "Set it up now"), () => { this.skipped = false; this.step = 0; this.renderWizard(this.state); }, 'primary')),
			));
			return;
		}
		if (this.finished) {
			reset(this.container as HTMLElement, $('.picode-card', {},
				$('p', {}, localize('picodeSetup.done', "You are all set. You can change any of this later from Settings > PiCode, or by running this setup again.")),
				$('.picode-gentle-actions', {},
					this.button('picode-setup-review', localize('picodeSetup.review', "Review the setup"), () => { this.finished = false; this.step = 0; this.renderWizard(this.state); }, 'primary'),
					this.button('picode-setup-end', localize('picodeSetup.end', "End the setup"), () => this.endForGood(), 'secondary')),
				...(this.endedNote !== undefined ? [$('p.picode-note' + (this.endedWithError ? '.picode-error' : ''), {}, this.endedNote)] : []),
			));
			return;
		}

		// Six steps: the PiCode Account sign-in, then pi, then (for the internal pi) the
		// provider and its model, then Gentle AI with its agents, then the pi packages,
		// then the theme. With the external pi the provider step has nothing to ask (its
		// providers are the machine's) and Gentle is dimmed.
		const body = this.step === 0
			? this.renderLoginStep()
			: this.step === 1
				? this.renderPiCard(state)
				: this.step === 2
					? (state.runtime === 'internal' ? this.renderProviderStep() : this.renderSkippedProvider())
					: this.step === 3
						? this.renderGentleStep(state)
						: this.step === 4
							? this.renderPackagesCard()
							: this.renderThemeCard();

		const foot = this.renderWizardFoot(state);
		this.wizardFootEl = foot;
		reset(
			this.container as HTMLElement,
			this.renderWizardHead(),
			$('.picode-step-body', {}, body),
			foot,
		);
	}

	/** The six dots and the "1 of 6 — Sign in" line. */
	private renderWizardHead(): HTMLElement {
		const names = [
			localize('picodeSetup.step.login', "Sign in"),
			localize('picodeSetup.step.pi', "pi"),
			localize('picodeSetup.step.provider', "Provider & model"),
			localize('picodeSetup.step.gentle', "Gentle AI"),
			localize('picodeSetup.step.packages', "Packages"),
			localize('picodeSetup.step.theme', "Theme"),
		];
		const dots = $('.picode-step-dots', {});
		for (let i = 0; i < 6; i += 1) {
			dots.appendChild($('.picode-dot' + (i === this.step ? '.on' : '')));
		}
		return $('.picode-wizard-head', {},
			dots,
			$('span.picode-step-label', {}, localize('picodeSetup.step.of', "{0} of 6 — {1}", String(this.step + 1), names[this.step])),
		);
	}

	/**
	 * Back / Next / Skip, the same three on every step, plus "Not now" at the far right.
	 *
	 * The pi chooser's Next is disabled until an option card is clicked. The last step has
	 * no Skip (there is nothing after it) and its Next is "Done". On the sign-in step the
	 * Next reads "Continue" once the owner is signed in.
	 */
	private renderWizardFoot(state: SetupState): HTMLElement {
		const back = this.navButton('picode-wizard-back', localize('picodeSetup.nav.back', "Back"), this.step > 0,
			() => this.goTo((this.step === 3 && state.runtime !== 'internal' ? 1 : this.step - 1) as 0 | 1 | 2 | 3 | 4 | 5));
		const nextLabel = this.step === 5 ? localize('picodeSetup.nav.done', "Done")
			: this.step === 1 ? localize('picodeSetup.nav.next', "Next")
			: this.step === 2 ? localize('picodeSetup.nav.nextModel', "Next — set the default model")
			: this.step === 0 && this.accountStatus?.signedIn ? localize('picodeSetup.nav.continue', "Continue")
				: localize('picodeSetup.nav.next', "Next");
		const next = this.navButton(
			'picode-wizard-next',
			nextLabel,
			this.step === 1 ? this.piChosen : this.step === 2 ? this.wizardModel !== undefined : !(this.busy && this.step === 3),
			() => this.advanceFrom(state),
			'primary',
		);
		if (this.step === 1 && !this.piChosen) {
			next.classList.add('disabled');
			next.title = localize('picodeSetup.nav.chooseFirst', "Choose a pi first — click one of the two options above.");
		}
		if (this.step === 2 && this.wizardModel === undefined) {
			next.classList.add('disabled');
			next.title = localize('picodeSetup.nav.chooseModel', "Pick the model your agent will run on.");
		}
		const foot = $('.picode-wizard-foot', {}, back, $('.picode-foot-spacer', {}));
		if (this.step < 5) {
			foot.append(this.navButton('picode-wizard-skip', localize('picodeSetup.nav.skip', "Skip"), !(this.busy && this.step === 3), () => this.advanceFrom(state, true)));
		}
		foot.append(
			this.button('picode-not-now', localize('picodeSetup.nav.notNow', "Not now"), () => this.skipAll(), 'quiet'),
			next,
		);
		return foot;
	}

	/**
		* The way forward from each step. The provider step persists the picked default
		* model (pi's own setting) before moving on; skipping it moves on without saving.
		*/
	private async advanceFrom(state: SetupState, skipping = false): Promise<void> {
		if (this.step === 0) {
			this.goTo(1);
			return;
		}
		if (this.step === 1) {
			this.goTo(state.runtime === 'internal' ? 2 : 3);
			return;
		}
		if (this.step === 2) {
			if (!skipping && this.wizardModel !== undefined) {
				try {
					await this.services.commandService.executeCommand('picode.setup.modelDefault', this.wizardModel);
				} catch (error) {
					this.setNote(messageOf(error), true);
					return;
				}
			}
			this.goTo(3);
			return;
		}
		if (this.step === 3) {
			this.goTo(4);
			return;
		}
		if (this.step === 4) {
			this.goTo(5);
			return;
		}
		this.finish();
	}

	/** A footer button; `enabled === false` renders it inert until something re-renders. */
	private navButton(id: string, label: string, enabled: boolean, onClick: () => void, style: 'primary' | 'secondary' | 'quiet' = 'secondary'): HTMLElement {
		const button = this.button(id, label, enabled ? onClick : () => { /* disabled */ }, style);
		if (!enabled) {
			button.classList.add('disabled');
		}
		return button;
	}

	/** Rebuilds the foot in place - the way a mid-step choice re-enables its buttons. */
	private repaintFoot(): void {
		const foot = this.wizardFootEl;
		if (foot !== undefined && this.state !== undefined) {
			const fresh = this.renderWizardFoot(this.state);
			foot.replaceWith(fresh);
			this.wizardFootEl = fresh;
		}
	}

	private goTo(step: 0 | 1 | 2 | 3 | 4 | 5): void {
		this.step = step;
		this.renderWizard(this.state);
	}

	/** Reaching the end marks the setup as done, so the first-run nudge stays quiet. */
	private finish(): void {
		this.finished = true;
		this.services.commandService.executeCommand('picode.setup.complete');
		this.renderWizard(this.state);
	}

	/** "Not now" steps the whole wizard aside; it is reopenable from the same card. */
	private skipAll(): void {
		this.skipped = true;
		this.services.commandService.executeCommand('picode.setup.complete');
		this.renderWizard(this.state);
	}

	/**
	 * "End the setup": the done mark the other exits set, plus the editor setting that
	 * keeps the welcome page from opening again on start. The connector owns both writes
	 * (`picode.setup.endForGood`); the page only says what came of them, in one line —
	 * and, the tab having served its purpose, the Welcome editor closes. The button lives
	 * in that editor, so it is the active one and closing the active editor is exactly
	 * this tab; "Review the setup" keeps working before the end, and the setup itself
	 * comes back from Settings > PiCode.
	 */
	private endForGood(): void {
		this.services.commandService.executeCommand('picode.setup.endForGood')
			.then(() => {
				this.endedNote = localize('picodeSetup.endNote', "Setup ended. You can bring it back from Settings > PiCode.");
				this.endedWithError = false;
				this.renderWizard(this.state);
				void this.services.commandService.executeCommand('workbench.action.closeActiveEditor');
			})
			.catch(error => {
				this.endedNote = messageOf(error);
				this.endedWithError = true;
				this.renderWizard(this.state);
			});
	}

	/**
	 * Step 1, the PiCode Account sign-in: the status as the authentication service sees
	 * it, the provider's own one-time-code flow behind one button, and the pricing line
	 * for the Pro plan the sync needs. Signing in is offered, never forced — the Next
	 * stays enabled for the owner who would rather set the editor up first (a Free
	 * account cannot sign in here at all).
	 */
	private renderLoginStep(): HTMLElement {
		const status = $('.picode-login-status');
		const card = $('.picode-card.picode-login-card', {},
			$('.picode-card-head', {},
				$('.picode-card-title', {}, localize('picodeSetup.login.title', "Sign in to PiCode")),
				$('span.picode-hint', {}, localize('picodeSetup.login.hint', "PiCode Account")),
			),
			$('p.picode-row-description', {}, localize('picodeSetup.login.detail',
				"Sync your settings, extensions and your pi profile across devices with a PiCode Account.")),
			status,
			$('.picode-login-pricing', {},
				localize('picodeSetup.login.pricing', "PiCode Sync requires a Pro account. Plans at "),
				this.pricingLink()),
		);
		// The state is asked once; the sign-in's own completion repaints it, as does any
		// later re-render of this step.
		if (this.accountStatus === undefined) {
			void this.services.commandService.executeCommand<AccountStatus>(PICODE_ACCOUNT_STATE_COMMAND)
				.then(answer => {
					if (answer === undefined || this._store.isDisposed || this.step !== 0) { return; }
					this.accountStatus = answer;
					const area = this.container.querySelector('.picode-login-status');
					if (area instanceof HTMLElement) { this.paintLoginStatus(area); }
					this.repaintFoot();
				})
				.catch(() => { /* the checking line stays; the sign-in button answers for itself */ });
		}
		this.paintLoginStatus(status);
		return card;
	}

	/** Repaints the login step's status area from the account status in hand. */
	private paintLoginStatus(area: HTMLElement): void {
		const status = this.accountStatus;
		if (status === undefined) {
			reset(area, $('.picode-gallery-loading', {}, localize('picodeSetup.login.checking', "Checking your account…")));
			return;
		}
		if (status.signedIn) {
			reset(area, $('.picode-login-signed-in', {},
				...(status.avatar !== undefined ? [$('img.picode-login-avatar', { 'src': status.avatar, 'alt': '' })] : []),
				$('span.picode-login-state', {}, localize('picodeSetup.login.signedInAs', "Signed in as {0}", status.label ?? '')),
			));
			return;
		}
		reset(area, $('.picode-login-signed-out', {},
			$('span.picode-login-state', {}, localize('picodeSetup.login.notSignedIn', "Not signed in")),
			this.button('picode-login-signin', localize('picodeSetup.login.signIn', "Sign in / Create account"), () => { void this.signIn(); }, 'primary'),
		));
	}

	/**
	 * "Sign in / Create account": the account provider's own browser flow, then the
	 * status repaints from the session it minted. Every failure — a cancelled sign-in,
	 * a Free account, an unreachable service — is one honest line in the card's note.
	 */
	private async signIn(): Promise<void> {
		this.setNote(localize('picodeSetup.login.opening', "Opening your browser to sign in…"), false);
		try {
			this.accountStatus = await this.services.commandService.executeCommand<AccountStatus>(PICODE_SIGN_IN_COMMAND);
			this.setNote('', false);
		} catch (error) {
			this.setNote(messageOf(error), true);
			this.accountStatus = { signedIn: false };
		}
		if (this.step === 0 && !this._store.isDisposed) {
			const area = this.container.querySelector('.picode-login-status');
			if (area instanceof HTMLElement) { this.paintLoginStatus(area); }
			this.repaintFoot();
		}
	}

	/** The pricing line's link, opened with the editor's own `vscode.open`. */
	private pricingLink(): HTMLElement {
		const link = $('a.picode-link', { 'href': PICODE_PRICING_URL, 'title': PICODE_PRICING_URL }, PICODE_PRICING_URL);
		this.disposables.add(addDisposableListener(link, 'click', event => {
			event.preventDefault();
			void this.services.commandService.executeCommand('vscode.open', URI.parse(PICODE_PRICING_URL));
		}));
		return link;
	}

	private renderPiCard(state: SetupState): HTMLElement {
		const external = this.renderPiOption({
			checked: state.runtime === 'external',
			available: state.externalAvailable,
			label: localize('picodeSetup.pi.external', "Your installed pi"),
			detail: localize('picodeSetup.pi.externalDetail', "The pi already on this machine. PiCode reads it and never writes to it."),
			icon: 'folder-library',
			mode: 'external',
			meta: state.externalAvailable
						? localize('picodeSetup.pi.externalFound', "Found on your computer — ready to use")
						: localize('picodeSetup.pi.externalUnknown', "Looking for pi on your computer… this can take a few seconds"),
		});
		const internal = this.renderPiOption({
			checked: state.runtime !== 'external',
			available: true,
			label: localize('picodeSetup.pi.internal', "Built-in pi (recommended)"),
			detail: localize('picodeSetup.pi.internalDetail', "Kept and updated by PiCode — its configuration lives inside the editor."),
			icon: 'vm',
			mode: 'internal',
			meta: state.internalPiVersion ? localize('picodeSetup.pi.internalVersion', "Version {0}", state.internalPiVersion) : undefined,
		});

		const card = $('.picode-card.picode-pi-card', {},
			$('.picode-card-head', {},
				$('span.picode-pi-mark'),
				$('.picode-card-title', {}, localize('picodeSetup.pi.title', "Choose your pi")),
				$('span.picode-hint', {}, state.runtime === 'internal'
					? localize('picodeSetup.pi.currentInternal', "In use: built-in pi")
					: localize('picodeSetup.pi.currentExternal', "In use: your installed pi")),
			),
			$('p.picode-pi-lede', {}, localize('picodeSetup.pi.lede', "PiCode comes with its own pi — ready from the first launch. Prefer your own installed pi? Point PiCode at it.")),
			$('.picode-pi-options', {}, internal, external),
			// The import shows only while the internal pi runs and the machine's profile has
			// something worth bringing; the counts arrive when the card asks for them.
			$('.picode-import-area'),
			this.renderNote(localize('picodeSetup.pi.note.internal', "Nothing is deleted: PiCode never writes to the pi installed on your machine.")),
		);

		// The machine's pi is probed once, after the card is on screen: the version needs a
		// process, and the card should not wait for it.
		this.services.commandService.executeCommand<ExternalPiInfo>('picode.setup.probeExternal')
			.then(info => {
				if (info === undefined || this._store.isDisposed || this.state?.runtime !== state.runtime) { return; }
				const meta = external.querySelector('.picode-pi-meta');
				if (!(meta instanceof HTMLElement)) { return; }
				if (info.found) {
					// The absolute path stays out of the UI on purpose: "found on your computer"
					// is what the owner needs, and the version when we know it.
					meta.textContent = info.version
						? localize('picodeSetup.pi.externalMeta', "Version {0}", info.version)
						: localize('picodeSetup.pi.externalFound', "Found on your computer — ready to use");
					meta.classList.remove('picode-warn');
				} else {
					meta.textContent = localize('picodeSetup.pi.notFound', "We couldn't find pi on your computer. Install it there, or use the one inside PiCode.");
					meta.classList.add('picode-warn');
				}
			})
			.catch(() => { /* the meta line keeps its placeholder; nothing to act on */ });

		// The import offer depends on facts only the connector has; it asks once, lazily.
		if (state.runtime !== 'external') {
			this.services.commandService.executeCommand<ProfilePreview>('picode.setup.importPreview')
				.then(preview => {
					if (preview === undefined || this._store.isDisposed || this.state?.runtime !== 'internal') { return; }
					const area = card.querySelector('.picode-import-area');
					if (!(area instanceof HTMLElement)) { return; }
					const worth = preview.exists && (preview.packages + preview.providers + preview.mcpServers + preview.skills + preview.sessions) > 0;
					if (worth) {
						reset(area, this.renderImportCta(preview));
					}
				})
				.catch(() => { /* no preview, no offer — the import is optional by definition */ });
		}

		return card;
	}

	private renderPiOption(options: {
		checked: boolean; available: boolean; label: string; detail: string; icon: string; mode: 'internal' | 'external'; meta?: string;
	}): HTMLElement {
		const card = $('button.picode-option-card' + (options.checked ? '.checked' : '') + (options.available ? '' : '.unavailable'),
			{
				'type': 'button',
				'tabindex': 0,
				'title': options.available ? undefined : localize('picodeSetup.pi.notFoundTitle', "We couldn't find pi on your computer."),
			},
			$(`span.codicon.codicon-${options.checked ? 'check' : options.icon}.picode-option-icon`),
			$('.picode-option-text', {},
				$('.picode-option-label', {}, options.label),
				$('.picode-option-detail', {}, options.detail),
				...(options.meta !== undefined || options.mode === 'external'
					? [$('.picode-pi-meta' + (options.available ? '' : '.picode-warn'), {}, options.meta ?? '')]
					: []),
			),
		);
		if (options.available) {
			this.disposables.add(addDisposableListener(card, 'click', () => this.applyRuntime(options.mode)));
			// Keyboard activation without a pointer: the card is a real button, and Enter and
			// Space fire click on their own for button elements.
		}
		return card;
	}

	private renderImportCta(preview: ProfilePreview): HTMLElement {
		this.importResult = undefined;
		const progressArea = $('.picode-import-progress-area');
		const credentialsRow = $('.picode-import-credentials', {},
			this.checkbox('picode-import-credentials-box', localize('picodeSetup.import.credentials', "Sign me in with my saved logins")),
		);
		const previewBox = $('.picode-import-preview', {},
			$('.picode-import-counts', {},
				this.importCount(localize('picodeSetup.import.packages', "Packages"), preview.packages),
				this.importCount(localize('picodeSetup.import.providers', "AI connections"), preview.providers),
				this.importCount(localize('picodeSetup.import.mcps', "MCP servers"), preview.mcpServers),
				this.importCount(localize('picodeSetup.import.skills', "Skills"), preview.skills),
				this.importCount(localize('picodeSetup.import.sessions', "Conversations"), preview.sessions),
			),
			progressArea,
			credentialsRow,
			$('.picode-import-note', {}, localize('picodeSetup.import.note', "Everything is copied into PiCode. Nothing is deleted — your external pi keeps working exactly as it is.")),
		);
		const result = this.importResult = $('.picode-import-result');

		// The import is a choice, not an event: it runs when the owner presses Import, and
		// the bar below takes over from there.
		const actions = $('.picode-import-actions', {},
			this.button('picode-import-confirm', localize('picodeSetup.import.confirm', "Import"), () => {
				actions.style.display = 'none';
				credentialsRow.style.display = 'none';
				this.renderImportProgress(progressArea);
				const box = credentialsRow.querySelector('input');
				const withLogins = box instanceof HTMLInputElement && box.checked;
				this.startImport(progressArea, result, withLogins);
			}, 'primary'),
		);

		if (this.importRunning) {
			// A re-render while the import runs: the bar comes back, the buttons stay away.
			actions.style.display = 'none';
			credentialsRow.style.display = 'none';
			this.renderImportProgress(progressArea);
		} else if (this.importReport) {
			this.renderImportDone(progressArea);
		}

		return $('.picode-import-cta', {}, previewBox, actions, result);
	}

	private importCount(label: string, value: number): HTMLElement {
		return $('.picode-import-count', {},
			$('span.picode-import-value', {}, String(value)),
			$('span.picode-import-label', {}, label),
		);
	}

	private renderImportProgress(area: HTMLElement): void {
		area.replaceChildren(
			$('.picode-import-progress', {}, $('.picode-import-progress-fill')),
			$('.picode-import-progress-line', {}, localize('picodeSetup.import.running', "Bringing everything over…")),
		);
	}

	private startImport(progressArea: HTMLElement, result: HTMLElement, withLogins: boolean): void {
		this.importRunning = true;
		const fill = (): HTMLElement | null => this.container.querySelector('.picode-import-progress-fill');
		const line = (): HTMLElement | null => this.container.querySelector('.picode-import-progress-line');

		const importRun = this.services.commandService.executeCommand<ImportReport & { packagesInstalled?: number; packagesFailed?: number; packagesSkipped?: number }>(
			'picode.setup.importFromExternal',
			withLogins,
		);

		// The bar: the connector counts one step for the copy, one per package and one for
		// the model refresh; the page polls and moves the fill along.
		const poll = window.setInterval(() => {
			void this.services.commandService.executeCommand<{ running: boolean; lines: string[]; step: number; total: number }>('picode.setup.importLog')
				.then(log => {
					if (!log) { return; }
					const pct = log.total > 0 ? Math.min(100, Math.round((log.step / log.total) * 100)) : 0;
					const fillEl = fill();
					if (fillEl instanceof HTMLElement) { fillEl.style.width = `${pct}%`; }
					const last = log.lines[log.lines.length - 1];
					const lineEl = line();
					if (last && lineEl) { lineEl.textContent = last; }
					if (!log.running) {
						window.clearInterval(poll);
					}
				})
				.catch(() => { /* the bar freezes; the command's own answer reports the failure */ });
		}, 500);
		this.disposables.add({ dispose: () => window.clearInterval(poll) });

		importRun.then(async report => {
			if (report === undefined || this._store.isDisposed) { return; }
			this.importReport = report;
			this.importRunning = false;
			// Gentle AI may have just arrived with the packages: re-read the state so the
			// Gentle step shows it as installed instead of offering the install again.
			this.state = await this.services.commandService.executeCommand<SetupState>('picode.setup.getState');
			this.renderImportDone(progressArea);
		}).catch(error => {
			this.importRunning = false;
			if (this.importResult) {
				this.importResult.textContent = messageOf(error);
				this.importResult.classList.add('picode-error');
			}
		});
	}

	private renderImportDone(progressArea: HTMLElement): void {
		const report = this.importReport;
		if (!report) { return; }
		progressArea.replaceChildren();

		if (this.importResult) {
			const packagesNote = (report.packagesInstalled ?? 0) + (report.packagesFailed ?? 0) + (report.packagesSkipped ?? 0) > 0
				? ' ' + localize('picodeSetup.import.packagesNote', "{0} packages installed, {1} failed, {2} skipped.", report.packagesInstalled ?? 0, report.packagesFailed ?? 0, report.packagesSkipped ?? 0)
				: '';
			this.importResult.textContent = report.failed > 0
				? localize('picodeSetup.import.doneWithFailures', "Finished with problems: {0} items brought over, {1} updated, {2} failed.", report.copied, report.overwritten, report.failed) + packagesNote
				: localize('picodeSetup.import.done', "Ready: {0} items brought over, {1} updated.", report.copied, report.overwritten) + packagesNote;
		}
	}

	/**
		* Step 2, for the internal pi: the provider, two ways - pi's own subscription login,
			* or a provider written by hand - and then the model, fetched from that provider,
			* with one of them picked as the default the agent runs on.
			*/
	private renderProviderStep(): HTMLElement {
		const form = this.renderProviderForm();
		form.hidden = true;
		const modelArea = $('.picode-model-area', {});
		this.currentModelArea = modelArea;

		const card = $('.picode-card.picode-provider-card', {},
			$('.picode-card-head', {},
				$('.picode-card-title', {}, localize('picodeSetup.provider.title', "Provider & model")),
				$('span.picode-hint', {}, localize('picodeSetup.provider.hint', "The provider your agent talks to, and the model it runs on.")),
			),
			$('.picode-pi-options', {},
				this.providerOption('oauth', 'cloud', localize('picodeSetup.provider.oauth', "Log in with a subscription"),
					localize('picodeSetup.provider.oauthDetail', "ChatGPT, Claude, Copilot… — pi's own OAuth login, with the account you already pay for."), () => {
					void this.services.commandService.executeCommand('picode.connectProvider');
				}),
				this.providerOption('manual', 'edit', localize('picodeSetup.provider.manual', "Add a provider by hand"),
					localize('picodeSetup.provider.manualDetail', "An address, a dialect and a key — an OpenAI-compatible endpoint works."), () => {
					form.hidden = !form.hidden;
				}),
			),
			form,
			modelArea,
			this.renderNote(localize('picodeSetup.provider.note', "The model you pick below is what the agent runs by default — you can change it per conversation.")),
		);

		if (this.wizardModels === undefined && !this.modelsLoading) {
			void this.loadWizardModels();
		}
		this.paintModels(modelArea);
		return card;
	}

	private providerOption(icon: string, _kind: string, label: string, detail: string, onClick: () => void): HTMLElement {
		const card = $('button.picode-option-card',
			{ 'type': 'button', 'tabindex': 0 },
			$(`span.codicon.codicon-${icon}.picode-option-icon`),
			$('.picode-option-text', {},
				$('.picode-option-label', {}, label),
				$('.picode-option-detail', {}, detail),
			),
		);
		this.disposables.add(addDisposableListener(card, 'click', event => {
			event.preventDefault();
			onClick();
		}));
		return card;
	}

	/** The hand-written provider's form, hidden until the owner picks that way in. */
	private renderProviderForm(): HTMLElement {
		const form = $('.picode-provider-form-inner', {});
		const input = (placeholder: string, id: string, kind = 'text'): HTMLElement =>
			$('input.picode-input', { 'type': kind, 'id': id, 'placeholder': placeholder });
		const name = input('provider name (no spaces)', 'picode-prov-id');
		const endpoint = input('endpoint, e.g. https://api.example.com/v1', 'picode-prov-endpoint');
		const key = input('API key (empty if the endpoint needs none)', 'picode-prov-key', 'password');
		const api = $('select.picode-select', { 'id': 'picode-prov-api' });
		for (const dialect of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
			api.appendChild($('option', { 'value': dialect }, dialect));
		}
		const add = this.button('picode-provider-add', localize('picodeSetup.provider.add', "Add provider"), async () => {
			this.busy = true;
			this.setNote(localize('picodeSetup.provider.adding', "Adding the provider and fetching its models…"), false);
			try {
				await this.services.commandService.executeCommand('picode.setup.providerAddManual', {
					id: (name as HTMLInputElement).value,
					endpoint: (endpoint as HTMLInputElement).value,
					api: (api as HTMLSelectElement).value,
					key: (key as HTMLInputElement).value,
				});
				this.wizardModels = undefined;
				form.hidden = true;
				this.setNote('', false);
				this.busy = false;
				await this.render();
			} catch (error) {
				this.busy = false;
				this.setNote(messageOf(error), true);
			}
		}, 'primary');
		form.append(
			$('.picode-form-row', {}, name),
			$('.picode-form-row', {}, endpoint),
			$('.picode-form-row', {}, api, key),
			$('.picode-form-actions', {}, add),
		);
		for (const field of [name, endpoint, key, api]) {
			this.disposables.add(addDisposableListener(field, 'keydown', event => event.stopPropagation()));
		}
		return form;
	}

	/** Step 2 with the external pi: nothing to ask, said plainly. */
	private renderSkippedProvider(): HTMLElement {
		return $('.picode-card', {},
			$('.picode-card-head', {},
				$('.picode-card-title', {}, localize('picodeSetup.provider.skippedTitle', "Providers")),
				$('span.picode-hint', {}, localize('picodeSetup.provider.skippedHint', "Handled by your external pi"))),
			$('p.picode-row-description', {}, localize('picodeSetup.provider.skippedDetail', "The pi on this machine keeps its own providers and credentials, which this editor never writes to. Next: Gentle AI — which also belongs to the internal pi — the pi packages, and your theme.")),
		);
	}

	/** The model list, fetched from the provider(s) and picked with a click. */
	private paintModels(area: HTMLElement): void {
		if (this.modelsLoading) {
			reset(area, $('.picode-gallery-loading', {}, localize('picodeSetup.provider.fetching', "Fetching the model list from your provider…")));
			return;
		}
		const models = this.wizardModels ?? [];
		if (models.length === 0) {
			reset(area, $('.picode-gallery-loading', {}, localize('picodeSetup.provider.noModels', "No models yet — log in with a subscription or add a provider by hand, and the list fills from it.")));
			return;
		}
		const rows = models.map(model => $('button.picode-model-row' + (this.wizardModel === model.ref ? '.checked' : ''),
			{ 'type': 'button', 'data-ref': model.ref, 'tabindex': 0 },
			$(`span.codicon.codicon-${this.wizardModel === model.ref ? 'check' : 'circle-large-outline'}`),
			$('span.picode-model-ref', {}, model.ref),
		));
		reset(area, $('.picode-model-list', {}, ...rows));
		this.registerModelRows(area);
	}

	private registerModelRows(area: HTMLElement): void {
		for (const row of area.querySelectorAll<HTMLButtonElement>('.picode-model-row')) {
			const ref = row.getAttribute('data-ref') ?? row.textContent ?? '';
			this.disposables.add(addDisposableListener(row, 'click', () => {
				this.wizardModel = ref;
				this.setNote(localize('picodeSetup.provider.chosen', "Default model: {0}", ref), false);
				const area2 = this.currentModelArea;
				if (area2 !== undefined) { this.paintModels(area2); }
				// The foot's Next was rendered disabled back when no model was chosen; it is
				// rebuilt here, enabled, or the pick would never unlock the way forward.
				const foot = this.wizardFootEl;
				if (foot !== undefined && this.state !== undefined) {
					const fresh = this.renderWizardFoot(this.state);
					foot.replaceWith(fresh);
					this.wizardFootEl = fresh;
				}
			}));
		}
	}

	private currentModelArea: HTMLElement | undefined;
	/** The foot element, kept so a choice made mid-step re-enables its Next. */
	private wizardFootEl: HTMLElement | undefined;

	private async loadWizardModels(): Promise<void> {
		this.modelsLoading = true;
		try {
			const answer = await this.services.commandService.executeCommand<{ models: WizardModel[] }>('picode.setup.modelsList');
			if (answer !== undefined) {
				this.wizardModels = answer.models;
			}
		} catch (error) {
			this.wizardModels = [];
			this.setNote(messageOf(error), true);
		}
		this.modelsLoading = false;
		// The model area repaints here, so the list appears the moment it lands.
		if (this.currentModelArea !== undefined && this.currentModelArea.isConnected) {
			this.paintModels(this.currentModelArea);
		}
	}

	/**
		* Gentle AI's own step: the install (always the latest version) and, once it is
			* on disk, the agent models - one row per agent, the owner's list from the
			* provider step as the choices, saved into the profile's subagents.json.
			*/
	private renderGentleStep(state: SetupState): HTMLElement {
		const dimmed = state.runtime !== 'internal';
		const card = this.renderGentleCard(state, dimmed);
		if (!dimmed && state.gentleInstalled) {
			// The agents' model rows, after the card: one per agent, pre-set to the
			// default model, changeable from the fetched list.
			if (this.gentleAgents === undefined) {
				void this.services.commandService.executeCommand<{ agents: string[] }>('picode.setup.gentleAgents')
					.then(answer => {
						if (answer === undefined) { return; }
						this.gentleAgents = answer.agents;
						this.agentProfiles = {};
						this.renderWizard(this.state);
					})
					.catch(() => { /* the card stays without the rows; the install still worked */ });
			}
			if (this.gentleAgents !== undefined && this.gentleAgents.length > 0 && (this.wizardModels ?? []).length > 0) {
				const agentsBox = $('.picode-agents-config', {},
					$('.picode-card-head', {},
						$('.picode-card-title', {}, localize('picodeSetup.agents.title', "Agent models")),
						$('span.picode-hint', {}, localize('picodeSetup.agents.hint', "Which model each of Gentle AI's agents runs on."))),
				);
				for (const agent of this.gentleAgents) {
					const select = $('select.picode-select.picode-agent-select', {});
					const chosen = this.agentProfiles[agent] ?? this.wizardModel ?? '';
					for (const model of this.wizardModels ?? []) {
						const option = $('option', { 'value': model.ref }, model.ref);
						if (model.ref === chosen) {
							option.setAttribute('selected', 'selected');
						}
						select.appendChild(option);
					}
					this.disposables.add(addDisposableListener(select, 'change', () => {
						this.agentProfiles[agent] = (select as HTMLSelectElement).value;
					}));
					this.disposables.add(addDisposableListener(select, 'keydown', event => event.stopPropagation()));
					agentsBox.appendChild($('.picode-agent-row', {},
						$('span.picode-agent-name', {}, agent),
						$('.picode-select-wrap', {}, select,
							$('span.codicon.codicon-chevron-down.picode-select-chevron')),
					));
				}
				const save = this.button('picode-agents-save', localize('picodeSetup.agents.save', "Save agent models"), async () => {
					try {
						await this.services.commandService.executeCommand('picode.setup.gentleAgentModels', {
							defaultModel: this.wizardModel,
							profiles: this.agentProfiles,
						});
						this.setNote(localize('picodeSetup.agents.saved', "Agent models saved."), false);
					} catch (error) {
						this.setNote(messageOf(error), true);
					}
				}, 'secondary');
				agentsBox.appendChild($('.picode-form-actions', {}, save));
				card.appendChild(agentsBox);
			}
		}
		return card;
	}

	private renderGentleCard(state: SetupState, dimmed: boolean): HTMLElement {
		const description = localize('picodeSetup.gentle.detail', "The agent layer for pi: subagents, skills and a memory that carries your context between sessions. Only for PiCode's internal pi.");

		const actions = $('.picode-gentle-actions', {});
		let status: string;
		if (dimmed) {
			status = localize('picodeSetup.gentle.external', "Belongs to your external pi");
		} else if (state.gentleInstalled) {
			status = localize('picodeSetup.gentle.on', "Installed");
			actions.append(
				this.button('picode-gentle-update', localize('picodeSetup.gentle.update', "Update"), () => this.applyGentle('update'), 'secondary'),
				this.button('picode-gentle-remove', localize('picodeSetup.gentle.remove', "Remove — use plain pi"), () => this.applyGentle('remove')),
			);
		} else {
			status = localize('picodeSetup.gentle.off', "Not installed");
			actions.append(
				this.button('picode-gentle-install', localize('picodeSetup.gentle.install', "Install Gentle AI"), () => this.applyGentle('install'), 'primary'),
			);
		}

		const card = $('.picode-card.picode-gentle-card' + (dimmed ? '.picode-dimmed' : ''),
			{
				'title': dimmed
					? localize('picodeSetup.gentle.externalTooltip', "Gentle AI is installed into PiCode's own profile, which only the internal pi uses. Your external pi keeps its own profile, and this editor never writes to it.")
					: undefined,
			},
			$('.picode-card-head', {},
				$('.picode-card-title', {}, localize('picodeSetup.gentle.title', "Gentle AI")),
				$('span.picode-hint', {}, status + (state.gentleVersion && !dimmed ? ` · v${state.gentleVersion}` : '')),
			),
			$('.picode-card-body', {}, $('span.picode-row-description', {}, description)),
			actions,
		);
		this.gentleStatus = $('.picode-gentle-status');
		card.appendChild(this.gentleStatus);
		// The installer's own output lands here while it runs; a card that talks is a
		// card that reassures.
		this.gentleLogEl = $('.picode-gentle-log');
		card.appendChild(this.gentleLogEl);
		return card;
	}

	/**
	 * The pi packages step, optional by nature: two sources in the theme gallery's pattern.
	 * "Installed" lists what pi already loads (read-only rows — management lives in the chat
	 * page's Packages section), and "Gallery" asks npm's catalog, searched with a pause,
	 * paged, one install per click into the profile in force.
	 */
	private renderPackagesCard(): HTMLElement {
		const grid = $('.picode-package-grid');
		const toolbar = $('.picode-theme-toolbar', {});
		const card = $('.picode-card.picode-package-card', {},
			$('.picode-card-head', {},
				$('.picode-card-title', {}, localize('picodeSetup.packages.title', "pi packages")),
				$('span.picode-hint', {}, localize('picodeSetup.packages.hint', "Optional — packages that extend pi. Skip this and nothing breaks.")),
			),
			toolbar,
			grid,
			$('.picode-theme-more', {}),
		);

		// Self-clearing, like the theme gallery: every invocation repaints the toolbar, the
		// rows and the "more" row from scratch, so repeated calls never stack.
		const repaint = (): void => {
			const more = card.querySelector('.picode-theme-more');
			if (!(more instanceof HTMLElement)) { return; }
			if (this.packageSource === 'gallery') {
				this.renderPackageGalleryInto(toolbar, grid, more, repaint);
			} else {
				this.renderInstalledPackagesInto(toolbar, grid, more, repaint);
			}
		};
		repaint();
		return card;
	}

	/** The Installed | Gallery tabs, the same chips the theme card uses. */
	private packageSourceTabs(onPick: () => void): HTMLElement {
		const tabs = $('.picode-source-tabs', {});
		const kinds: ReadonlyArray<{ kind: 'installed' | 'gallery'; label: string }> = [
			{ kind: 'installed', label: localize('picodeSetup.packages.tabInstalled', "Installed") },
			{ kind: 'gallery', label: localize('picodeSetup.packages.tabGallery', "Gallery") },
		];
		for (const kind of kinds) {
			const chip = $('button.picode-source-tab' + (this.packageSource === kind.kind ? '.checked' : ''), { 'type': 'button', 'tabindex': 0 }, kind.label);
			this.disposables.add(addDisposableListener(chip, 'click', () => {
				if (this.packageSource === kind.kind) { return; }
				onPick();
			}));
			tabs.appendChild(chip);
		}
		return tabs;
	}

	/** Whether a catalog name is already installed here, by npm name or declared source. */
	private isPackageInstalled(name: string): boolean {
		return (this.installedPackages ?? []).some(pkg =>
			pkg.name === name || pkg.id === name || pkg.source === `npm:${name}` || pkg.source === name);
	}

	/** The line both sources render first when a load is running or the last one failed. */
	private packageStateRow(): HTMLElement | undefined {
		if (this.packagesError !== '') {
			return $('.picode-gallery-loading.picode-error', {},
				localize('picodeSetup.packages.error', "The package list could not be loaded: {0}", this.packagesError));
		}
		if (this.packagesLoading) {
			return $('.picode-gallery-loading', {}, localize('picodeSetup.packages.loading', "Asking for the packages…"));
		}
		return undefined;
	}

	/** The detail line one row shows: the description when there is one, the version after it. */
	private packageDetail(description: string | undefined, version: string | undefined): HTMLElement[] {
		if (description === undefined && version === undefined) { return []; }
		const text = [description, version !== undefined ? `v${version}` : undefined]
			.filter((part): part is string => part !== undefined)
			.join(' · ');
		return [$('span.picode-theme-publisher', {}, text)];
	}

	private renderInstalledPackagesInto(toolbar: HTMLElement, grid: HTMLElement, more: HTMLElement, repaint: () => void): void {
		reset(toolbar);
		toolbar.append(this.packageSourceTabs(() => {
			this.packageSource = 'gallery';
			this.packagesShown = PACKAGE_GALLERY_PAGE;
			repaint();
		}));
		clearNode(grid);
		clearNode(more);

		// The first visit to the tab has nothing cached yet: ask the connector first.
		if (this.installedPackages === undefined) {
			void this.loadInstalledPackages(repaint);
		}
		const stateRow = this.packageStateRow();
		if (stateRow !== undefined) {
			grid.appendChild(stateRow);
			return;
		}
		const rows = this.installedPackages ?? [];
		if (rows.length === 0) {
			grid.appendChild($('.picode-gallery-loading', {},
				localize('picodeSetup.packages.noneInstalled', "No pi packages installed yet — the Gallery tab has some.")));
			return;
		}
		const list = $('.picode-model-list', {});
		for (const pkg of rows) {
			list.appendChild($('.picode-agent-row', {},
				$('.picode-package-meta', {},
					$('span.picode-package-name', {}, pkg.name),
					...this.packageDetail(pkg.description, pkg.version)),
				...(pkg.state === 'disabled'
					? [$('span.picode-theme-badge', {}, localize('picodeSetup.packages.disabled', "Disabled"))]
					: []),
			));
		}
		grid.appendChild(list);
	}

	private renderPackageGalleryInto(toolbar: HTMLElement, grid: HTMLElement, more: HTMLElement, repaint: () => void): void {
		reset(toolbar);
		toolbar.append(this.packageSourceTabs(() => {
			this.packageSource = 'installed';
			repaint();
		}));
		clearNode(grid);
		clearNode(more);

		const search = this.packageSearch(text => {
			this.packageQuery = text;
			this.packagesShown = PACKAGE_GALLERY_PAGE;
			// One request per pause, not per keystroke — the theme gallery's own rhythm.
			if (this.packageSearchTimer !== undefined) {
				clearTimeout(this.packageSearchTimer);
			}
			this.packageSearchTimer = setTimeout(() => {
				this.packageSearchTimer = undefined;
				void this.loadPackageCatalog(repaint);
			}, 350);
		});
		toolbar.append(search);

		more.append(
			this.button('picode-packages-show-more', localize('picodeSetup.packages.showMore', "Show more packages"), () => {
				this.packagesShown += PACKAGE_GALLERY_PAGE;
				this.renderPackageGalleryInto(toolbar, grid, more, repaint);
			}),
		);

		// The first visit to the tab has nothing cached yet: ask the catalog first.
		if (this.packageCatalog === undefined) {
			void this.loadPackageCatalog(repaint);
		}
		const stateRow = this.packageStateRow();
		if (stateRow !== undefined) {
			grid.appendChild(stateRow);
			return;
		}
		const rows = (this.packageCatalog ?? []).slice(0, this.packagesShown);
		if (rows.length === 0) {
			grid.appendChild($('.picode-gallery-loading', {},
				localize('picodeSetup.packages.noneFound', "Nothing in the catalog for that search.")));
			return;
		}
		const list = $('.picode-model-list', {});
		for (const row of rows) {
			const installed = this.isPackageInstalled(row.name);
			const install = installed
				? this.button('picode-package-install', localize('picodeSetup.packages.installed', "Installed"), () => { /* already in place */ }, 'secondary')
				: this.installingPackage === row.name
					? this.button('picode-package-install', localize('picodeSetup.packages.installing', "Installing…"), () => { /* already running */ }, 'secondary')
					: this.button('picode-package-install', localize('picodeSetup.packages.install', "Install"), () => {
						void this.installCatalogPackage(row, repaint);
					}, 'secondary');
			// One install at a time: while one runs, every install button goes inert.
			if (installed || this.installingPackage !== undefined) {
				install.classList.add('disabled');
			}
			list.appendChild($('.picode-agent-row', {},
				$('.picode-package-meta', {},
					$('span.picode-package-name', {}, row.name),
					...this.packageDetail(row.description, row.version)),
				install,
			));
		}
		grid.appendChild(list);
	}

	private async loadInstalledPackages(repaint: () => void): Promise<void> {
		if (this.packagesLoading) { return; }
		this.packagesLoading = true;
		try {
			const answer = await this.services.commandService.executeCommand<InstalledPackage[]>('picode.setup.packages');
			if (answer !== undefined) {
				this.installedPackages = answer;
				this.packagesError = '';
			}
		} catch (error) {
			this.installedPackages = [];
			this.packagesError = messageOf(error);
		}
		this.packagesLoading = false;
		repaint();
	}

	private async loadPackageCatalog(repaint: () => void): Promise<void> {
		if (this.packagesLoading) { return; }
		this.packagesLoading = true;
		try {
			const answer = await this.services.commandService.executeCommand<CatalogPackage[]>('picode.packages.search', this.packageQuery);
			if (answer !== undefined) {
				this.packageCatalog = answer;
				this.packagesError = '';
			}
		} catch (error) {
			this.packageCatalog = [];
			this.packagesError = messageOf(error);
		}
		this.packagesLoading = false;
		repaint();
	}

	/**
	 * Installs one catalog package, then refreshes the installed rows so both tabs agree.
	 * The result's own sentence is the error line when pi says no; nothing here throws.
	 */
	private async installCatalogPackage(row: CatalogPackage, repaint: () => void): Promise<void> {
		if (this.installingPackage !== undefined) { return; }
		this.installingPackage = row.name;
		this.packagesError = '';
		repaint();
		try {
			const result = await this.services.commandService.executeCommand<PackageInstallResult>('picode.packages.install', row.name);
			this.installingPackage = undefined;
			if (result !== undefined && !result.ok) {
				this.packagesError = result.message;
			} else {
				// The rows come back from the connector before the gallery repaints, so the
				// installed package's own row turns to "Installed" instead of offering a
				// second install of what is already in place.
				this.installedPackages = undefined;
				await this.loadInstalledPackages(repaint);
			}
		} catch (error) {
			this.installingPackage = undefined;
			this.packagesError = messageOf(error);
		}
		repaint();
	}

	/** The gallery's search box: the theme search's twin, with its own labels. */
	private packageSearch(onInput: (query: string) => void): HTMLElement {
		const input = $('input.picode-theme-search', {
			'type': 'text',
			'placeholder': localize('picodeSetup.packages.search', "Search packages…"),
			'aria-label': localize('picodeSetup.packages.searchAria', "Search pi packages"),
		});
		this.disposables.add(addDisposableListener(input, 'input', () => onInput((input as HTMLInputElement).value)));
		// The page around the grid listens for keys; the search box keeps them for typing.
		this.disposables.add(addDisposableListener(input, 'keydown', event => event.stopPropagation()));
		return input;
	}

	/**
	 * The theme card, in two sources: the installed themes (live preview on hover, applied
	 * on click) and the gallery - what Open VSX has, searched by name, each card painted
	 * with the theme's own colors and installed on click. The tabs, the search box and the
	 * "Show more" button are rebuilt by the source's renderer, because they behave
	 * differently in each.
	 */
	private renderThemeCard(): HTMLElement {
		let query = '';
		let filter: 'all' | 'dark' | 'light' | 'hc' = 'all';
		let shown = THEME_PAGE_SIZE;

		const grid = $('.picode-theme-grid');
		const currentLabel = $('span.picode-hint');
		const head = $('.picode-card-head', {},
			$('.picode-card-title', {}, localize('picodeSetup.theme.title', "Theme")),
			currentLabel,
		);

		const applyTheme = async (theme: IWorkbenchColorTheme, persist: boolean): Promise<void> => {
			await this.services.themeService.setColorTheme(theme.settingsId, persist ? undefined : 'preview');
			if (persist) {
				this.appliedThemeId = theme.settingsId;
				this.services.commandService.executeCommand('picode.setup.complete');
			}
			this.paintCurrent(head, grid, this.visibleThemes(query, filter).slice(0, shown));
		};

		const toolbar = $('.picode-theme-toolbar', {});
		const card = $('.picode-card.picode-theme-card', {},
			head,
			toolbar,
			grid,
			$('.picode-theme-more', {}),
		);

		const repaint = (): void => {
			clearNode(grid);
			reset(toolbar);
			toolbar.append(this.themeSourceTabs(() => { this.themeSource = this.themeSource === 'installed' ? 'gallery' : 'installed'; this.galleryShown = THEME_GALLERY_PAGE; repaint(); }));
			const more = card.querySelector('.picode-theme-more');
			if (!(more instanceof HTMLElement)) { return; }
			clearNode(more);
			if (this.themeSource === 'gallery') {
				currentLabel.textContent = '';
				this.renderGalleryInto(toolbar, grid, more, applyTheme);
				return;
			}
			toolbar.append(
				this.themeSearch(text => { query = text; shown = THEME_PAGE_SIZE; this.paintGrid(grid, this.visibleThemes(query, filter).slice(0, shown), applyTheme); }),
				this.themeFilters(kind => { filter = kind; shown = THEME_PAGE_SIZE; this.paintGrid(grid, this.visibleThemes(query, filter).slice(0, shown), applyTheme); }),
			);
			more.append(
				this.button('picode-theme-show-more', localize('picodeSetup.theme.showMore', "Show more themes"), () => {
					shown += THEME_PAGE_SIZE;
					this.paintGrid(grid, this.visibleThemes(query, filter).slice(0, shown), applyTheme);
				}),
				this.button('picode-theme-browse', localize('picodeSetup.theme.browse', "Install more from the gallery…"), () => {
					this.services.commandService.executeCommand('workbench.extensions.search', '@category:themes @sort:installs');
				}),
			);
			this.paintCurrent(head, grid, this.visibleThemes(query, filter).slice(0, shown));
			this.paintGrid(grid, this.visibleThemes(query, filter).slice(0, shown), applyTheme);
		};

		repaint();
		return card;
	}

	/** The Installed | Gallery tabs. */
	private themeSourceTabs(onPick: () => void): HTMLElement {
		const tabs = $('.picode-source-tabs', {});
		const kinds: ReadonlyArray<{ kind: 'installed' | 'gallery'; label: string }> = [
			{ kind: 'installed', label: localize('picodeSetup.theme.tabInstalled', "Installed") },
			{ kind: 'gallery', label: localize('picodeSetup.theme.tabGallery', "Gallery") },
		];
		for (const kind of kinds) {
			const chip = $('button.picode-source-tab' + (this.themeSource === kind.kind ? '.checked' : ''), { 'type': 'button', 'tabindex': 0 }, kind.label);
			this.disposables.add(addDisposableListener(chip, 'click', () => {
				if (this.themeSource === kind.kind) { return; }
				onPick();
			}));
			tabs.appendChild(chip);
		}
		return tabs;
	}

	/**
		* The gallery grid: what Open VSX has, one card per theme, thumbnailed from the
		* theme's own colors once its file lands in the cache. Clicking installs the
		* extension and then applies the theme; hovering previews nothing (the theme is not
		* on disk yet) - the thumbnail is the preview.
		*/
	/**
		* The gallery grid: what Open VSX has, one card per theme, thumbnailed from the
		* theme's own colors once its file lands in the cache.
		*
		* Self-clearing, on purpose: every invocation resets the toolbar, the grid and the
			* "more" row before painting. The earlier version appended and re-invoked itself
			* per keystroke, which multiplied the toolbar and the "Show more" buttons into a
			* hall of mirrors.
		*/
	private renderGalleryInto(toolbar: HTMLElement, grid: HTMLElement, more: HTMLElement, applyTheme: (theme: IWorkbenchColorTheme, persist: boolean) => Promise<void>): void {
		reset(toolbar);
		toolbar.append(this.themeSourceTabs(() => {
			this.themeSource = 'installed';
			this.render();
		}));
		clearNode(grid);
		clearNode(more);

		const search = this.themeSearch(text => {
			this.galleryQuery = text;
			this.galleryShown = THEME_GALLERY_PAGE;
			// One request per pause, not per keystroke.
			if (this.gallerySearchTimer !== undefined) {
				clearTimeout(this.gallerySearchTimer);
			}
			this.gallerySearchTimer = setTimeout(() => {
				this.gallerySearchTimer = undefined;
				void this.loadGallery(() => this.renderGalleryInto(toolbar, grid, more, applyTheme));
			}, 350);
		});
		toolbar.append(search);

		more.append(
			this.button('picode-theme-show-more', localize('picodeSetup.theme.showMore', "Show more themes"), () => {
				this.galleryShown += THEME_GALLERY_PAGE;
				this.renderGalleryInto(toolbar, grid, more, applyTheme);
			}),
		);

		// The first visit to the tab has nothing cached yet: ask the gallery before
		// declaring it empty.
		if (this.galleryItems === undefined) {
			void this.loadGallery(() => this.renderGalleryInto(toolbar, grid, more, applyTheme));
		}

		const items = (this.galleryItems ?? []).slice(0, this.galleryShown);
		if (items.length === 0) {
			grid.appendChild(this.galleryLoading
				? $('.picode-gallery-loading', {}, localize('picodeSetup.gallery.loading', "Asking the gallery…"))
				: $('.picode-gallery-loading', {}, localize('picodeSetup.gallery.empty', "Nothing in the gallery for that search.")));
			return;
		}

		for (const item of items) {
			const installed = (this.themes ?? []).some(theme => theme.label === item.variant.label);
			const thumb = $('.picode-theme-thumb');
			const card = $('button.picode-theme-card',
				{ 'type': 'button', 'tabindex': 0, 'title': `${item.label} · ${item.publisher}` },
				thumb,
				$('.picode-theme-meta', {},
					$('.picode-theme-label', {}, item.variant.label),
					$('.picode-theme-publisher', {}, installed
						? localize('picodeSetup.gallery.installed', "installed — pick it in Installed")
						: `${item.publisher} · ${item.downloads}`),
				),
			);
			this.disposables.add(addDisposableListener(card, 'click', () => { void this.installFromGallery(item); }));
			grid.appendChild(card);
			// The thumbnail's colors live in the theme's own file, inside its VSIX; one
			// download per theme, cached, and the card paints when it lands.
			void this.loadGalleryThumb(thumb, item);
		}
	}

	private async loadGallery(repaint: () => void): Promise<void> {
		if (this.galleryLoading) { return; }
		this.galleryLoading = true;
		try {
			const answer = await this.services.commandService.executeCommand<{ items: GalleryItem[] }>('picode.setup.gallerySearch', this.galleryQuery);
			if (answer !== undefined) {
				this.galleryItems = answer.items;
			}
		} catch (error) {
			this.galleryItems = [];
			this.setNote(messageOf(error), true);
		}
		this.galleryLoading = false;
		repaint();
	}

	private async loadGalleryThumb(thumb: HTMLElement, item: GalleryItem): Promise<void> {
		try {
			const palette = await this.services.commandService.executeCommand<GalleryPalette>('picode.setup.galleryThumb', {
				id: item.id,
				version: item.version,
				downloadUrl: item.downloadUrl,
				declared: item.variant,
			});
			if (palette === undefined || !thumb.isConnected) { return; }
			thumb.style.background = palette.bg;
			reset(thumb, ...this.thumbLines(palette));
		} catch {
			// The placeholder stays: an unreadable theme is never painted with wrong colors.
			return;
		}
	}

	/** Four sample code lines in the theme's own palette, shared by both grid sources. */
	private thumbLines(palette: { bg: string; fg: string; ln: string; a: readonly [string, string, string, string] }): HTMLElement[] {
		const line = (lnNo: string, tokens: ReadonlyArray<{ text: string; color: 'fg' | 0 | 1 | 2 | 3 }>): HTMLElement =>
			$('.picode-thumb-line', {},
				$('span.picode-thumb-ln', { style: `color:${palette.ln}` }, lnNo),
				...tokens.map(token => $('span.picode-thumb-token',
					{ style: `color:${token.color === 'fg' ? palette.fg : palette.a[token.color]}` }, token.text)),
			);
		return [
			line('1', [{ text: 'const', color: 0 }, { text: ' pi ', color: 'fg' }, { text: '= ', color: 'fg' }, { text: 'await', color: 0 }, { text: ' setup', color: 3 }, { text: '();', color: 'fg' }]),
			line('2', [{ text: '// your agent is built in', color: 1 }]),
			line('3', [{ text: 'return', color: 0 }, { text: ' theme', color: 3 }, { text: '(', color: 'fg' }, { text: '"picode"', color: 2 }, { text: ');', color: 'fg' }]),
			line('4', [{ text: 'import', color: 0 }, { text: ' { work } ', color: 'fg' }, { text: 'from', color: 0 }, { text: ' "pi"', color: 2 }, { text: ';', color: 'fg' }]),
			line('5', [{ text: 'export', color: 0 }, { text: ' class ', color: 3 }, { text: 'Agent', color: 'fg' }, { text: ' { }', color: 'fg' }]),
		];
	}

	/** Installs a gallery theme, then applies it once it is an installed theme. */
	private async installFromGallery(item: GalleryItem): Promise<void> {
		if (this.busy) { return; }
		this.busy = true;
		this.setNote(localize('picodeSetup.gallery.installing', "Installing {0}…", item.label), false);
		try {
			await this.services.commandService.executeCommand('picode.setup.galleryInstall', item.id);
			this.themes = await this.services.themeService.getColorThemes();
			const applied = (this.themes ?? []).find(theme => theme.label === item.variant.label);
			if (applied !== undefined) {
				await this.services.themeService.setColorTheme(applied.settingsId, undefined);
				this.appliedThemeId = applied.settingsId;
			}
			this.setNote(localize('picodeSetup.gallery.installedNote', "{0} installed and applied.", item.label), false);
		} catch (error) {
			this.setNote(messageOf(error), true);
			this.busy = false;
			return;
		}
		this.busy = false;
		this.themeSource = 'installed';
		await this.render();
	}

	private visibleThemes(query: string, filter: 'all' | 'dark' | 'light' | 'hc'): readonly IWorkbenchColorTheme[] {
		const themes = this.themes ?? [];
		const needle = query.trim().toLowerCase();
		return themes.filter(theme => {
			if (needle !== '' && !theme.label.toLowerCase().includes(needle)) { return false; }
			switch (filter) {
				case 'dark': return theme.type === 'dark';
				case 'light': return theme.type === 'light';
				case 'hc': return theme.type === 'hcDark' || theme.type === 'hcLight';
				default: return true;
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * The theme grid
	 * ------------------------------------------------------------------ */

	private paintCurrent(head: HTMLElement, grid: HTMLElement, visible: readonly IWorkbenchColorTheme[]): void {
		const applied = visible.find(theme => theme.settingsId === this.appliedThemeId);
		const existing = head.querySelector('.picode-hint');
		if (existing instanceof HTMLElement) {
			existing.textContent = applied?.label ?? localize('picodeSetup.theme.currentOutsidePage', "The theme in force is not in this list");
		}
		grid.querySelectorAll('.picode-theme-card').forEach(el => {
			el.classList.toggle('checked', el.getAttribute('data-theme-id') === this.appliedThemeId);
		});
	}

	private paintGrid(grid: HTMLElement, themes: readonly IWorkbenchColorTheme[], applyTheme: (theme: IWorkbenchColorTheme, persist: boolean) => Promise<void>): void {
		this.gridDisposables.clear();
		clearNode(grid);
		const applied = this.appliedThemeId;

		for (const theme of themes) {
			const thumb = $('.picode-theme-thumb');
			const card = $('button.picode-theme-card' + (theme.settingsId === applied ? '.checked' : ''),
				{ 'type': 'button', 'data-theme-id': theme.settingsId, 'tabindex': 0, 'title': theme.label },
				thumb,
				$('.picode-theme-meta', {},
					$('span.picode-theme-label', {}, theme.label),
					...(theme.settingsId === applied ? [$('span.picode-theme-badge', {}, localize('picodeSetup.theme.current', "Current"))] : []),
				),
			);

			// Live preview: the theme is applied with the preview target while the pointer or
			// the keyboard focus sits on the card, and the theme in force comes back on leave.
			this.gridDisposables.add(addDisposableListener(card, 'mouseenter', () => { void applyTheme(theme, false); }));
			this.gridDisposables.add(addDisposableListener(card, 'focusin', () => { void applyTheme(theme, false); }));
			this.gridDisposables.add(addDisposableListener(card, 'mouseleave', () => { void this.restorePreview(applyTheme); }));
			this.gridDisposables.add(addDisposableListener(card, 'focusout', () => { void this.restorePreview(applyTheme); }));
			this.gridDisposables.add(addDisposableListener(card, 'click', () => { void applyTheme(theme, true); }));

			grid.appendChild(card);

			// The thumbnail needs the theme's own colors, which live in its file on disk;
			// loading happens lazily, one card at a time, after the card is painted.
			this.loadThumbail(thumb, theme);
		}
		this.paintCurrent(grid.closest('.picode-card') as HTMLElement ?? grid, grid, themes);
	}

	private async restorePreview(applyTheme: (theme: IWorkbenchColorTheme, persist: boolean) => Promise<void>): Promise<void> {
		const original = (this.themes ?? []).find(theme => theme.settingsId === this.appliedThemeId);
		if (original) {
			await applyTheme(original, false);
		}
	}

	/**
	 * Paints one thumbnail from the theme's own data.
	 *
	 * The colors are the theme's: the frame comes from its `editor.*` colors once the theme
	 * data is loaded, and the accents from the first of its token rules that names each
	 * common scope. A theme that cannot be read keeps a neutral placeholder — never a wrong
	 * color presented as the theme's.
	 */
	private async loadThumbail(thumb: HTMLElement, theme: IWorkbenchColorTheme): Promise<void> {
		const data = theme as ColorThemeData;
		try {
			await data.ensureLoaded(this.services.extensionResourceLoaderService);
		} catch {
			return; // placeholder stays
		}
		if (this._store.isDisposed || !thumb.isConnected) { return; }

		const bg = data.getColor(editorBackground)?.toString() ?? '#1e1e1e';
		const fg = data.getColor(editorForeground)?.toString() ?? '#cccccc';
		const ln = data.getColor(editorLineNumbers)?.toString() ?? '#6e7681';
		const accents = this.accentColors(data, fg);

		const line = (lnNo: string, tokens: ReadonlyArray<{ text: string; color: 'fg' | 0 | 1 | 2 | 3 }>): HTMLElement =>
			$('.picode-thumb-line', {},
				$('span.picode-thumb-ln', { style: `color:${ln}` }, lnNo),
				...tokens.map(token => $('span.picode-thumb-token',
					{ style: `color:${token.color === 'fg' ? fg : accents[token.color]}` }, token.text)),
			);

		reset(thumb,
			line('1', [{ text: 'const', color: 0 }, { text: ' pi ', color: 'fg' }, { text: '= ', color: 'fg' }, { text: 'await', color: 0 }, { text: ' setup', color: 3 }, { text: '();', color: 'fg' }]),
			line('2', [{ text: '// your agent is built in', color: 1 }]),
			line('3', [{ text: 'return', color: 0 }, { text: ' theme', color: 3 }, { text: '(', color: 'fg' }, { text: '"picode"', color: 2 }, { text: ');', color: 'fg' }]),
			line('4', [{ text: 'import', color: 0 }, { text: ' { work } ', color: 'fg' }, { text: 'from', color: 0 }, { text: ' "pi"', color: 2 }, { text: ';', color: 'fg' }]),
		);
		thumb.style.background = bg;
	}

	/** Four accent colors from the theme's own token rules: keyword, string, comment, function. */
	private accentColors(data: ColorThemeData, fallback: string): readonly [string, string, string, string] {
		const wanted: ReadonlyArray<{ key: 0 | 1 | 2 | 3; scope: string }> = [
			{ key: 0, scope: 'keyword' },
			{ key: 1, scope: 'string' },
			{ key: 2, scope: 'comment' },
			{ key: 3, scope: 'entity.name.function' },
		];
		const found: string[] = [fallback, fallback, fallback, fallback];
		for (const rule of data.tokenColors ?? []) {
			if (typeof rule.settings?.foreground !== 'string') { continue; }
			const scopes = typeof rule.scope === 'string' ? [rule.scope] : Array.isArray(rule.scope) ? rule.scope : [];
			for (const want of wanted) {
				if (found[want.key] !== fallback) { continue; }
				if (scopes.some(scope => scope.includes(want.scope))) {
					const color = Color.fromHex(rule.settings.foreground);
					if (color !== undefined) {
						found[want.key] = color.toString();
					}
				}
			}
		}
		// SAFETY: `found` is keyed by the wanted color keys; the tuple view is the
		// fixed-shape contract the theme reader below consumes, built from exactly
		// those keys in the same order.
		return found as unknown as readonly [string, string, string, string];
	}

	/* ------------------------------------------------------------------ *
	 * Actions
	 * ------------------------------------------------------------------ */

	private async applyRuntime(mode: 'internal' | 'external'): Promise<void> {
		if (this.busy || this.state === undefined) { return; }
		if (mode === 'external' && !this.state.externalAvailable) { return; }
		this.busy = true;
		// Clicking the option already in force also counts as the choice — it is what
		// unlocks the wizard's Next on a setup that was finished long ago.
		this.setNote(mode !== this.state.runtime ? localize('picodeSetup.pi.switching', "Switching pi…") : '', false);
		try {
			this.state = await this.services.commandService.executeCommand<SetupState>('picode.setup.applyRuntime', mode);
			this.piChosen = true;
		} catch (error) {
			this.setNote(messageOf(error), true);
			this.busy = false;
			return;
		}
		this.busy = false;
		await this.render();
	}

	private async applyGentle(action: 'install' | 'update' | 'remove'): Promise<void> {
		if (this.busy || this.state === undefined || this.state.runtime !== 'internal') { return; }
		this.busy = true;
		// The card's buttons go inert for the whole run: a second click is a no-op by the
		// busy guard, but it should also LOOK dead while the installer works.
		const gentleCard = this.gentleLogEl?.closest('.picode-card');
		if (gentleCard instanceof HTMLElement) {
			for (const button of gentleCard.querySelectorAll('.picode-gentle-actions .picode-button')) {
				button.classList.add('disabled');
			}
		}
		this.repaintFoot();
		// The install takes a while; the bridge logs its steps, and this poll paints
		// them as they happen - a card that talks is a card that reassures.
		const poll = setInterval(() => {
			void this.services.commandService
				.executeCommand<{ running: boolean; lines: string[]; step: number; total: number }>('picode.setup.gentleLog')
				.then(log => {
					if (log === undefined || this.gentleLogEl === undefined || !this.gentleLogEl.isConnected) { return; }
					const pct = log.total > 0 ? Math.round(log.step / log.total * 100) : 0;
					const bar = $('.picode-gentle-progress', {},
						$('.picode-gentle-progress-bar', { style: `width:${pct}%` }),
					);
					const label = $('.picode-gentle-progress-label', {}, `${pct}%`);
					reset(this.gentleLogEl, bar, label, ...log.lines.slice(-3).map(line => $('.picode-gentle-log-line', {}, line)));
					// While the installer runs, the card's buttons and the way forward are
					// visually locked (the busy guard already makes them no-ops).
					const card = this.gentleLogEl.closest('.picode-card');
					if (card instanceof HTMLElement) {
						for (const button of card.querySelectorAll('.picode-button')) {
							button.classList.toggle('disabled', log.running);
						}
					}
				})
				.catch(() => { /* the next tick tries again */ });
		}, 1200);
		if (this.gentleStatus) {
			this.gentleStatus.textContent = action === 'install'
				? localize('picodeSetup.gentle.installing', "Installing — pi's own installer runs; this can take a moment…")
				: action === 'update'
					? localize('picodeSetup.gentle.updating', "Updating…")
					: localize('picodeSetup.gentle.removing', "Removing…");
		}
		try {
			this.state = await this.services.commandService.executeCommand<SetupState>('picode.setup.applyGentle', action);
			this.setNote('', false);
		} catch (error) {
			this.setNote(messageOf(error), true);
		}
		clearInterval(poll);
		this.busy = false;
		await this.render();
	}

	/* ------------------------------------------------------------------ *
	 * Small builders
	 * ------------------------------------------------------------------ */

	private button(id: string, label: string, onClick: () => void, style: 'primary' | 'secondary' | 'quiet' = 'secondary'): HTMLElement {
		const kind = style === 'primary' ? '.primary' : style === 'quiet' ? '.quiet' : '';
		const button = $('button.picode-button' + kind, { 'type': 'button', 'id': id }, label);
		this.disposables.add(addDisposableListener(button, 'click', event => {
			event.preventDefault();
			onClick();
		}));
		return button;
	}

	private checkbox(id: string, label: string): HTMLElement {
		const input = $('input.picode-checkbox', { 'type': 'checkbox', 'id': id });
		// A click on the label toggles the box natively through `for`; the id ties them.
		const label2 = $('label', { 'for': id }, label);
		return $('.picode-checkbox-row', {}, input, label2);
	}

	private themeSearch(onInput: (query: string) => void): HTMLElement {
		const input = $('input.picode-theme-search', {
			'type': 'text',
			'placeholder': localize('picodeSetup.theme.search', "Search themes…"),
			'aria-label': localize('picodeSetup.theme.searchAria', "Search themes by name"),
		});
		this.disposables.add(addDisposableListener(input, 'input', () => onInput((input as HTMLInputElement).value)));
		// The page around the grid listens for keys (scrolling, shortcuts); the search box
		// keeps them for typing.
		this.disposables.add(addDisposableListener(input, 'keydown', event => event.stopPropagation()));
		return input;
	}

	private themeFilters(onPick: (kind: 'all' | 'dark' | 'light' | 'hc') => void): HTMLElement {
		const chips = $('.picode-theme-filters', {});
		const kinds: ReadonlyArray<{ kind: 'all' | 'dark' | 'light' | 'hc'; label: string }> = [
			{ kind: 'all', label: localize('picodeSetup.theme.all', "All") },
			{ kind: 'dark', label: localize('picodeSetup.theme.dark', "Dark") },
			{ kind: 'light', label: localize('picodeSetup.theme.light', "Light") },
			{ kind: 'hc', label: localize('picodeSetup.theme.hc', "High contrast") },
		];
		for (const kind of kinds) {
			const chip = $('button.picode-filter-chip' + (kind.kind === 'all' ? '.checked' : ''), { 'type': 'button', 'tabindex': 0 }, kind.label);
			this.disposables.add(addDisposableListener(chip, 'click', () => {
				chips.querySelectorAll('.picode-filter-chip').forEach(el => el.classList.remove('checked'));
				chip.classList.add('checked');
				onPick(kind.kind);
			}));
			chips.appendChild(chip);
		}
		return chips;
	}

	private renderNote(message: string): HTMLElement {
		this.note = $('p.picode-note', {}, message);
		return this.note;
	}

	private setNote(message: string, isError: boolean): void {
		if (this.note !== undefined) {
			this.note.innerText = message;
			this.note.classList.toggle('picode-error', isError);
		}
	}

	public override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}

/** The sentence an error carries, whatever threw it. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Renders the setup into the given container and returns the handle that disposes it.
 *
 * The welcome page calls this once per rebuild of its slide; the previous handle is
 * disposed before a new one is made.
 */
export function renderPiCodeSetup(container: HTMLElement, services: PiCodeSetupServices): PiCodeSetup {
	const setup = new PiCodeSetup(container, services);
	void setup.render();
	return setup;
}

/* ------------------------------------------------------------------ *
 * The PiCode Account commands the sign-in step calls
 * ------------------------------------------------------------------ */

let accountCommandsRegistered = false;

/**
 * Registers the two account commands behind the sign-in step, once per session.
 *
 * They are plain workbench commands rather than extension contributions: the PiCode
 * Account is the editor's own first-party provider, and calling the authentication
 * service directly is what keeps the owner's sign-in inside the flow the provider
 * already owns (the one-time code in the browser) with no extra consent detour.
 */
function registerAccountCommands(): void {
	if (accountCommandsRegistered) {
		return;
	}
	accountCommandsRegistered = true;

	CommandsRegistry.registerCommand(PICODE_ACCOUNT_STATE_COMMAND, async (accessor: ServicesAccessor): Promise<AccountStatus> => {
		const authenticationService = accessor.get(IAuthenticationService);
		// The provider registers as the workbench finishes restoring; give it a moment
		// rather than answering "not signed in" while the window is still starting.
		for (let waited = 0; !authenticationService.isAuthenticationProviderRegistered(PICODE_AUTH_PROVIDER_ID) && waited < 6; waited += 1) {
			await new Promise<void>(resolve => setTimeout(resolve, 500));
		}
		if (!authenticationService.isAuthenticationProviderRegistered(PICODE_AUTH_PROVIDER_ID)) {
			return { signedIn: false };
		}
		try {
			const sessions = await authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, PICODE_AUTH_SCOPES);
			const session = sessions[0];
			return session === undefined
				? { signedIn: false }
				: { signedIn: true, label: session.account.label, avatar: session.account.icon?.toString(true) };
		} catch {
			// A state that cannot be read is a state without a session to show; the
			// sign-in button is the honest way forward either way.
			return { signedIn: false };
		}
	});

	CommandsRegistry.registerCommand(PICODE_SIGN_IN_COMMAND, async (accessor: ServicesAccessor): Promise<AccountStatus> => {
		const authenticationService = accessor.get(IAuthenticationService);
		// The provider's own flow: the browser opens, the web app sends back a one-time
		// code, and the session is minted here. Cancellations, timeouts and a Free plan
		// reject — the page reports what came of it in one line.
		const session = await authenticationService.createSession(PICODE_AUTH_PROVIDER_ID, PICODE_AUTH_SCOPES);
		return { signedIn: true, label: session.account.label, avatar: session.account.icon?.toString(true) };
	});
}

registerAccountCommands();
