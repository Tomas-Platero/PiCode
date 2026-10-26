/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { onboardingReason, readOnboardingFlag, writeOnboardingFlag } from './picodeOnboardingFlag.js';
import { registerSetupWindowState, signInFromSetup } from './picodeAccountSignIn.js';
import { StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IEncryptionService } from '../../platform/encryption/common/encryptionService.js';
import { secretStorageKey } from '../../platform/secrets/common/secrets.js';

/**
 * PiCode's setup, in a window of its own and **before** the editor exists.
 *
 * Why before: the welcome page's cards compete with everything the editor already puts on
 * screen — a sidebar inviting a folder, a chat inviting a word, a status bar reporting things
 * nobody has configured yet. The setup asks three questions and then gets out of the way, so it
 * runs on its own window, with no workbench behind it, and the editor is opened only when the
 * setup answers or is skipped.
 *
 * What it guarantees, in order of importance:
 *
 * 1. **The editor always opens.** Every failure — a missing file, a renderer that dies, a window
 *    closed halfway, a backend that never answers — ends in a resolved promise and an editor.
 *    Nothing here throws to its caller.
 * 2. **The flag is the only thing this module trusts.** `onboarding.json` next to the
 *    installation's data records `{ completed, onboardingVersion, productVersion }`. A later
 *    start reads it and does nothing at all — no window, no process, no delay.
 * 3. **The window does not touch the disk.** It asks; the backend (`resources/onboarding/host.cjs`,
 *    which loads the connector's own `onboarding-host`) writes. The only exception is the flag
 *    and the folder the owner picked, which belong to the main process by definition.
 *
 * The same window serves the first run, a version upgrade and the in-editor "PiCode: Setup"
 * command: `mode` tells the page which of the three it is, and it preselects from the state it
 * is given instead of asking again what is already configured.
 */

/**
 * Leaves the editor signed in **without starting it**.
 *
 * The session is a refresh token in the editor's encrypted storage plus a few application values
 * beside it. Both stores belong to this process — not to a renderer — so the setup writes exactly
 * what the editor would have written: same key, same scope, same target, same encryption. The
 * editor then finds a session at start instead of asking a browser for one.
 */
async function storeEditorSession(deps: OnboardingDeps, session: { refreshToken: string; uid: string; email: string; picture?: string }): Promise<void> {
	const storage = deps.applicationStorage;
	const encryption = deps.encryptionService;
	if (storage === undefined || encryption === undefined) {
		deps.logService.warn('[picode-onboarding] the editor stores are not reachable; the session will be completed at start instead');
		return;
	}
	try {
		// Storage opens while windows start; writing before it is ready would land in memory only.
		// But the setup can finish before any window exists, so the wait is bounded: if the stores
		// are not open in a few seconds, the code is left for the editor to redeem instead of leaving
		// the window stuck on "waiting" for ever.
		const ready = await Promise.race([
			storage.whenReady.then(() => true),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000)),
		]);
		if (!ready) {
			deps.logService.warn('[picode-onboarding] the editor stores did not open in time; leaving the sign-in for the editor to finish');
			return;
		}
		const encrypted = await encryption.encrypt(session.refreshToken);
		storage.store(secretStorageKey('picode.account.refreshToken'), encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
		storage.store('picode.account.uid', session.uid, StorageScope.APPLICATION, StorageTarget.MACHINE);
		storage.store('picode.account.email', session.email, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (session.picture) {
			storage.store('picode.account.picture', session.picture, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		storage.store('picode.account.scopes', JSON.stringify([]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		deps.logService.info(`[picode-onboarding] the editor is signed in as ${session.email || session.uid} (written by the setup)`);
	} catch (error) {
		deps.logService.warn('[picode-onboarding] the session could not be written to the editor stores', error);
	}
}

/** How the page tells the three situations apart. */
export type OnboardingMode = 'first-run' | 'update' | 'setup';

export { ONBOARDING_VERSION, majorVersion, onboardingReason, readOnboardingFlag, writeOnboardingFlag, type OnboardingFlag } from './picodeOnboardingFlag.js';

/** The main-process services this module needs. */
/**
 * The slice of the main process's application storage this module uses.
 *
 * Its own interface because the decorator that provides it is typed as the *service registry*
 * (`IStorageMainService`) rather than the storage itself, and this module wants the three members
 * it actually calls — plus `whenReady`, without which a write lands in memory and never reaches the
 * disk.
 */
export interface EditorApplicationStore {
	readonly whenReady: Promise<void>;
	store(key: string, value: unknown, scope: StorageScope, target: StorageTarget): void;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined;
	remove(key: string, scope: StorageScope): void;
}

export interface OnboardingDeps {
	readonly environmentMainService: IEnvironmentMainService;
	readonly productService: IProductService;
	readonly logService: ILogService;
	/** The editor's own application storage and encryption: what the account session lives in. */
	readonly applicationStorage?: EditorApplicationStore;
	readonly encryptionService?: IEncryptionService;
}


/**
 * Where the flag lives: the installation's data directory, so it is **one state per
 * installation** rather than one per window, profile or workspace.
 *
 * A portable install passes `<root>/data` in `VSCODE_PORTABLE`; elsewhere the editor's own user
 * data directory is the equivalent place and is used as it is.
 */
export function onboardingDataDir(deps: Pick<OnboardingDeps, 'environmentMainService'>): string {
	return process.env['VSCODE_PORTABLE'] ?? deps.environmentMainService.userDataPath;
}

/** The distribution root: `<root>` in a pack, the repository in a dev run. */
export function distributionRootOf(environmentMainService: IEnvironmentMainService): string {
	const appRoot = environmentMainService.appRoot;
	return /[\\/]resources[\\/]app$/.test(appRoot) ? dirname(dirname(appRoot)) : appRoot;
}

/** The folder holding this window's page, its preload and its backend. */
export function onboardingResourceDir(deps: OnboardingDeps): string | undefined {
	const appRoot = deps.environmentMainService.appRoot;
	const root = distributionRootOf(deps.environmentMainService);
	const candidates = [join(root, 'resources', 'onboarding'), join(appRoot, 'resources', 'onboarding')];
	return candidates.find(candidate => existsSync(join(candidate, 'index.html')));
}

/**
 * The connector's compiled folder, whose `onboarding-host.js` does the writes.
 *
 * The setup shares the connector's modules instead of carrying a second copy of the profile
 * logic: the same `profile-import`, `declarations` and `endpoint` the editor uses at runtime.
 */
export function connectorOutDir(deps: OnboardingDeps): string | undefined {
	const appRoot = deps.environmentMainService.appRoot;
	const root = distributionRootOf(deps.environmentMainService);
	const candidates = [join(appRoot, 'extensions', 'picode', 'out'), join(root, 'resources', 'app', 'extensions', 'picode', 'out')];
	return candidates.find(candidate => existsSync(join(candidate, 'onboarding-host.js')));
}

/**
 * The internal pi profile: PiCode's own, shared by the editor and this window.
 *
 * The same rule the connector uses (`internalProfileDir` in `extensions/picode/src/runtime.ts`):
 * a portable install keeps its data elsewhere and says so in `VSCODE_PORTABLE`, and everything
 * that belongs to that installation — the profile included — moves with it. The two are written
 * separately only because this one runs before any extension host exists; they must not drift.
 */
export function internalProfileDir(deps: OnboardingDeps): string {
	const portable = process.env['VSCODE_PORTABLE'];
	const dataDir = portable !== undefined && portable.length > 0 ? portable : join(distributionRootOf(deps.environmentMainService), 'data');
	return join(dataDir, 'pi-agent');
}

/** One answer from the backend process. */
interface HostAnswer {
	readonly ok: boolean;
	readonly data?: unknown;
	readonly error?: string;
}

/**
 * Runs one backend command in a child process.
 *
 * A process per command, on purpose: importing a profile or projecting a provider can fail in
 * ways that should not be able to take the window down, and a crashed child is a sentence the
 * page can show rather than a blank window. The child is plain node (`ELECTRON_RUN_AS_NODE`), so
 * it needs neither a workbench nor a display.
 */
async function runHostCommand(deps: OnboardingDeps, resources: string, connector: string, command: string, payload: Record<string, unknown>): Promise<HostAnswer> {
	const script = join(resources, 'host.cjs');
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ELECTRON_RUN_AS_NODE: '1',
		PICODE_ONBOARDING_CONNECTOR: connector,
		PICODE_ONBOARDING_DISTRIBUTION_ROOT: distributionRootOf(deps.environmentMainService),
		PICODE_ONBOARDING_PROFILE_DIR: internalProfileDir(deps),
		PICODE_ONBOARDING_USER_DATA: deps.environmentMainService.userDataPath,
	};
	return new Promise<HostAnswer>(resolve => {
		// Only the marked lines are answers; everything else on stdout is pi's own chatter (npm
		// installs its declared packages the first time it loads) and is logged, never parsed.
		const child = spawn(process.execPath, [script, command], { env, windowsHide: true });
		let pending = '';
		let answer = '';
		let finished = false;
		const finish = (value: HostAnswer): void => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish({ ok: false, error: 'the setup backend took too long' });
		}, 180_000);
		const takeLines = (chunk: string): void => {
			pending += chunk;
			let index = pending.indexOf('\n');
			while (index >= 0) {
				const line = pending.slice(0, index).trim();
				pending = pending.slice(index + 1);
				index = pending.indexOf('\n');
				if (line.startsWith(PROTOCOL_MARK)) {
					answer = line.slice(PROTOCOL_MARK.length);
				} else if (line.length > 0) {
					deps.logService.trace(`[picode-onboarding] ${command}: ${line.slice(0, 400)}`);
				}
			}
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', takeLines);
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => deps.logService.trace(`[picode-onboarding] ${command} (stderr): ${chunk.trim().slice(0, 400)}`));
		child.on('error', error => finish({ ok: false, error: error.message }));
		child.on('exit', () => {
			if (pending.trim().startsWith(PROTOCOL_MARK)) {
				answer = pending.trim().slice(PROTOCOL_MARK.length);
			}
			if (answer.length === 0) {
				finish({ ok: false, error: 'the setup backend answered nothing' });
				return;
			}
			try {
				finish(JSON.parse(answer) as HostAnswer);
			} catch {
				finish({ ok: false, error: 'the setup backend answered something unreadable' });
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

/** The one setup window, if one is open. */
let currentWindow: BrowserWindow | undefined;
/** The opener the workbench command uses, registered by `CodeApplication`. */
let setupWindowOpener: (() => void) | undefined;

/** Registers how the editor asks for the setup again. */
export function registerSetupWindowOpener(opener: () => void): void {
	setupWindowOpener = opener;
}

/** Called by the in-editor command: opens the same window, without blocking anything. */
export function requestSetupWindow(): boolean {
	if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
		currentWindow.focus();
		return true;
	}
	if (setupWindowOpener === undefined) {
		return false;
	}
	setupWindowOpener();
	return true;
}

/** What the page is told about the folder the owner picked on the last step. */
export interface OnboardingOutcome {
	/** A folder chosen on the last step, handed to the editor's first window. */
	readonly folder?: string;
}

interface SetupWindowResult {
	readonly folder?: string;
}

/**
 * Shows the setup and waits for it — with every path out leading to the editor.
 *
 * The promise settles when the page says it is done, when the window is closed (the X means
 * "skip", and the flag is recorded so it does not come back), when the renderer dies, or when
 * the window fails to load at all. It never rejects.
 */
/** Cancels the account sign-in that is waiting for a browser, if one is. */
let stopAccountSignIn: (() => void) | undefined;

/** The sign-in in progress, if any. One at a time: two browsers for one account is a mess. */
let loginChild: ChildProcessWithoutNullStreams | undefined;
/**
 * Which attempt the events belong to.
 *
 * A cancelled sign-in's child can still be exiting when the next one starts, and its `exit` would
 * otherwise land on a page that is now watching a different attempt. Every event carries the
 * number of the run that produced it, and the window ignores the ones it is not following.
 */
let loginRun = 0;

/** Stops a sign-in that is running, if it is. */
function stopLogin(): void {
	if (loginChild === undefined) {
		return;
	}
	const child = loginChild;
	loginChild = undefined;
	try {
		child.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`);
	} catch {
		// The pipe may already be gone; killing it below is what matters.
	}
	setTimeout(() => {
		if (child.exitCode === null) {
			child.kill();
		}
	}, 1500);
}

/**
 * Who the editor says it is signed in as, read from the shared settings file.
 *
 * One source of truth: the editor writes `picode.account.sessionEmail` on every auth change, and both
 * surfaces read it. Empty (or a file without it) means signed out.
 */
function readSignedInEmail(deps: OnboardingDeps): string {
	// The editor's storage is the one place both sides write, so it is the truth. The settings mirror
	// is only a stand-in for the moment storage is not reachable; trusting it over storage kept a
	// card saying "signed in" after a sign-out that had already cleared the storage.
	if (deps.applicationStorage !== undefined) {
		try {
			const stored = deps.applicationStorage.get('picode.account.email', StorageScope.APPLICATION);
			return typeof stored === 'string' ? stored : '';
		} catch {
			// Fall through to the mirror below.
		}
	}
	try {
		const raw: unknown = JSON.parse(readFileSync(join(deps.environmentMainService.userDataPath, 'User', 'settings.json'), 'utf8'));
		const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['picode.account.sessionEmail'] : undefined;
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	} catch {
		// No settings file yet: the stored session below is still an answer.
	}
	// The editor mirrors the session into its settings only once it has started, so a sign-in made
	// in this window and then closed is not there yet. The session itself is: the setup wrote it to
	// the editor's own storage, and a sign-out clears it from the same place.
	try {
		const stored = deps.applicationStorage?.get('picode.account.email', StorageScope.APPLICATION);
		return typeof stored === 'string' ? stored : '';
	} catch {
		return '';
	}
}

/** The signed-in account's avatar address, kept by whichever side signed in, or empty. */
function readSignedInPicture(deps: OnboardingDeps): string {
	try {
		const stored = deps.applicationStorage?.get('picode.account.picture', StorageScope.APPLICATION);
		return typeof stored === 'string' ? stored : '';
	} catch {
		return '';
	}
}

export async function showOnboardingWindow(deps: OnboardingDeps, mode: OnboardingMode): Promise<SetupWindowResult> {
	const resources = onboardingResourceDir(deps);
	const connector = connectorOutDir(deps);
	if (resources === undefined || connector === undefined) {
		deps.logService.warn('[picode-onboarding] the setup window is not installed; opening the editor instead');
		return {};
	}

	const window = new BrowserWindow({
		width: 1100,
		height: 720,
		minWidth: 880,
		minHeight: 620,
		center: true,
		show: false,
		autoHideMenuBar: true,
		title: 'PiCode',
		backgroundColor: '#0b1016',
		webPreferences: {
			// A session of its own, and not only for tidiness: the editor's main process
			// **refuses every `file://` request** on its default session
			// (`protocolMainService.ts` intercepts the scheme and aborts it), which is exactly
			// what a local page needs. An in-memory partition has neither that interception nor
			// the editor's request filters, and it also keeps the setup's page away from the
			// workbench's storage.
			partition: 'picode-setup',
			preload: join(resources, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});
	currentWindow = window;

	// One promise, and every way out of it goes through `finish()`.
	//
	// The rule that took a morning to learn: **this window must never be the reason the editor has
	// zero windows.** VS Code quits when its last window closes (`window-all-closed` →
	// `app.quit()`), and the setup window *is* the last one while the editor has not been opened
	// yet. Closing it therefore disposed the whole application, and the editor that started right
	// after failed with "Trying to add a disposable to a DisposableStore that has already been
	// disposed of" and took the process down. So the window is **hidden** when the answer arrives,
	// the editor opens with it still alive, and it is destroyed as soon as another window exists.
	let settleOne: (result: SetupWindowResult) => void = () => { /* replaced below */ };
	const closed = new Promise<SetupWindowResult>(resolveClosed => {
		settleOne = resolveClosed;
	});

	let resolved = false;
	const settle = (result: SetupWindowResult): void => {
		if (resolved) {
			return;
		}
		resolved = true;
		settleOne(result);
	};

	/** Set once the page (or the owner) has answered; it carries the last step's result. */
	let finishResult: SetupWindowResult | undefined;
	let finishing = false;

	/** Takes the window off screen and destroys it once the editor's own window exists. */
	const finish = (result: SetupWindowResult, reason: string): void => {
		deps.logService.info(`[picode-onboarding] the setup is finishing (${reason})`);
		if (finishing) {
			return;
		}
		finishing = true;
		finishResult = result;
		if (window.isDestroyed()) {
			settle(result);
			return;
		}
		// Opened from the editor (`PiCode: Setup`), so another window already exists: there is no
		// zero-window moment to protect against, and it can go straight away.
		const otherWindows = BrowserWindow.getAllWindows().filter(other => other !== window && !other.isDestroyed());
		if (otherWindows.length > 0) {
			window.destroy();
			settle(result);
			return;
		}
		window.hide();
		const destroyOnceAnotherWindowExists = (): void => {
			clearTimeout(timer);
			if (!window.isDestroyed()) {
				window.destroy();
			}
		};
		// If no other window ever appears there is nothing to protect, and a hidden window left
		// behind would be worse than one that closes: close it either way, just not first.
		const timer = setTimeout(destroyOnceAnotherWindowExists, 10_000);
		app.once('browser-window-created', destroyOnceAnotherWindowExists);
		settle(result);
	};

	// The owner closing the window is a skip, and `close` is the one event that can be held back:
	// it is turned into the same path as "Skip setup", so the window goes away *after* the editor
	// has a window of its own.
	window.on('close', event => {
		if (finishing) {
			return; // our own `destroy()`, which has to be left alone
		}
		event.preventDefault();
		// The caller is the whole question here: a close request nobody asked for must be traceable
		// to whatever sent it, or "the window closed itself" stays a mystery.
		const caller = new Error('close request').stack?.split('\n').slice(2, 6).map(line => line.trim()).join(' <- ') ?? 'sin traza';
		deps.logService.info(`[picode-onboarding] the setup window got a close request (focused=${!window.isDestroyed() && window.isFocused()}, visible=${!window.isDestroyed() && window.isVisible()}, windows=${BrowserWindow.getAllWindows().length}); opening the editor`);
		deps.logService.info(`[picode-onboarding] close request origin: ${caller}`);
		writeOnboardingFlag(onboardingDataDir(deps), deps.productService.version, deps.logService);
		finish({}, 'close-request');
	});

	// Reached when we destroyed it ourselves, or if it went away by some other route (a page
	// crash destroys the renderer, not the window). Either way the gate settles here, once.
	window.on('closed', () => {
		if (currentWindow === window) {
			unregisterIpc();
			currentWindow = undefined;
		}
		settle(finishResult ?? {});
	});

	window.webContents.on('render-process-gone', (_event, details) => {
		deps.logService.warn(`[picode-onboarding] the setup window stopped (${details.reason}); opening the editor`);
		finish({}, 'render-process-gone');
	});
	window.webContents.on('did-fail-load', (_event, code, description, url) => {
		deps.logService.warn(`[picode-onboarding] the setup page failed to load (${code} ${description} ${url}); opening the editor`);
		finish({}, 'did-fail-load');
	});

	unregisterIpc();
	// The editor publishes its auth state in the settings file; watching it is what keeps the two
	// surfaces in step while both are open — sign out in the editor and the card here says so.
	const settingsFile = join(deps.environmentMainService.userDataPath, 'User', 'settings.json');
	let lastEmail = `${readSignedInEmail(deps)}|${readSignedInPicture(deps)}`;
	const watcher = setInterval(() => {
		if (window.isDestroyed()) {
			return;
		}
		const email = readSignedInEmail(deps);
		const picture = readSignedInPicture(deps);
		// The avatar is part of the answer: the editor stores it just after the email, and the card
		// must repaint when it arrives, not only when the email changes.
		const key = `${email}|${picture}`;
		if (key !== lastEmail) {
			lastEmail = key;
			window.webContents.send(CHANNELS.accountState, { email, picture });
		}
	}, 1000);
	window.on('closed', () => clearInterval(watcher));
	void settingsFile;

	const channels = registerIpc(deps, {
		mode,
		window,
		resources,
		connector,
		finish: result => finish(result, 'page'),
	});

	// Show on the first paint, and again after a successful load: a window that never paints
	// would otherwise be an invisible window the owner cannot close.
	//
	// It is brought to the front on purpose. The setup is the first thing a new install has to
	// say, and a window that opens *behind* whatever was already on screen is a window nobody
	// answers — the editor then opens with the setup "skipped" and the owner never saw it.
	// `setAlwaysOnTop` is dropped as soon as the page has focus, so it does not sit over the
	// editor afterwards.
	const reveal = (): void => {
		if (window.isDestroyed()) {
			return;
		}
		window.setAlwaysOnTop(true);
		window.show();
		window.focus();
		setTimeout(() => {
			if (!window.isDestroyed()) {
				window.setAlwaysOnTop(false);
			}
		}, 1500);
	};
	window.once('ready-to-show', reveal);
	try {
		await window.loadFile(join(resources, 'index.html'));
		if (!window.isDestroyed() && !window.isVisible()) {
			reveal();
		}
		// Loaded without an error is not the same as painted: this says the page is on screen, and
		// `bootstrap` below says its own script ran.
		deps.logService.info('[picode-onboarding] the setup window is on screen');
	} catch (error) {
		deps.logService.warn('[picode-onboarding] the setup page could not be opened; opening the editor', error);
		finish({}, 'load-failed');
	}

	try {
		return await closed;
	} finally {
		channels.dispose();
	}
}

/* ------------------------------------------------------------------ *
 * IPC — and nothing beyond what the page needs
 * ------------------------------------------------------------------ */

interface IpcOptions {
	readonly mode: OnboardingMode;
	readonly window: BrowserWindow;
	readonly resources: string;
	readonly connector: string;
	readonly finish: (result: SetupWindowResult) => void;
}

/** The channel names, in one place so the preload and this file cannot drift. */
const CHANNELS = {
	bootstrap: 'picode-onboarding:bootstrap',
	command: 'picode-onboarding:command',
	finish: 'picode-onboarding:finish',
	chooseFolder: 'picode-onboarding:choose-folder',
	clone: 'picode-onboarding:clone',
	accountSignIn: 'picode-onboarding:account-sign-in',
	accountCancel: 'picode-onboarding:account-cancel',
	accountEvent: 'picode-onboarding:account-event',
	accountState: 'picode-onboarding:account-state',
	accountSignOut: 'picode-onboarding:account-sign-out',
	openExternal: 'picode-onboarding:open-external',
	copyText: 'picode-onboarding:copy-text',
	loginStart: 'picode-onboarding:login-start',
	loginAnswer: 'picode-onboarding:login-answer',
	loginCancel: 'picode-onboarding:login-cancel',
	loginEvent: 'picode-onboarding:login-event',
} as const;

/**
 * The only addresses the setup page may hand to the operating system.
 *
 * A page that can open any URL can be pointed at anything, so the list is the providers the
 * setup itself offers plus the product's own site — nothing that the page could invent.
 */
const execFileAsync = promisify(execFile);

/** What the setup backend prefixes its own lines with, so npm's output cannot be mistaken for it. */
const PROTOCOL_MARK = '##picode##';

const OPENABLE_HOSTS: readonly string[] = [
	'openrouter.ai',
	'platform.deepseek.com',
	'deepseek.com',
	'console.groq.com',
	'platform.openai.com',
	'anthropic.com',
	'console.anthropic.com',
	'github.com',
	'picode.dev',
];

/**
 * The sign-in addresses pi itself announced during the sign-in now running.
 *
 * A provider's own sign-in page (claude.ai, auth.openai.com, a device-code page...) is not one of
 * the hosts above and cannot be: pi picks it. It is safe to open because it came from pi's own
 * process, not from the page, and only that exact address is allowed.
 */
const announcedSignInAddresses = new Set<string>();

/** Whether an address is https and its host is on the list above. */
export function isOpenableAddress(raw: unknown): boolean {
	if (typeof raw !== 'string') {
		return false;
	}
	if (announcedSignInAddresses.has(raw)) {
		return true;
	}
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:') {
			return false;
		}
		return OPENABLE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
	} catch {
		return false;
	}
}

function unregisterIpc(): void {
	for (const channel of Object.values(CHANNELS)) {
		ipcMain.removeHandler(channel);
	}
}

/**
 * Registers the five channels the page may use, and nothing else.
 *
 * Every handler answers only to the setup window's own web contents: these are global channels,
 * and a page that is not this window must not be able to write into the profile.
 */
function registerIpc(deps: OnboardingDeps, options: IpcOptions): { dispose: () => void } {
	const sender = options.window.webContents.id;

	const fromThisWindow = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === sender;
	const guard = <A extends unknown[], R>(handler: (...args: A) => Promise<R>): ((event: Electron.IpcMainInvokeEvent, ...args: A) => Promise<R | { ok: false; error: string }>) => {
		return async (event, ...args) => {
			if (!fromThisWindow(event)) {
				return { ok: false, error: 'not the setup window' };
			}
			try {
				return await handler(...args);
			} catch (error) {
				deps.logService.warn('[picode-onboarding] a setup request failed', error);
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		};
	};

	ipcMain.handle(CHANNELS.bootstrap, guard(async () => {
		deps.logService.info(`[picode-onboarding] the setup page asked for its state (${options.mode})`);
		const state = await runHostCommand(deps, options.resources, options.connector, 'state', {});
		return {
			ok: true,
			mode: options.mode,
			version: deps.productService.version,
			platform: process.platform,
			dataDir: onboardingDataDir(deps),
			snapshot: state.ok ? state.data : undefined,
			// Who is signed in right now, so a reopened setup starts on the truth instead of waiting
			// for a change that never comes.
			accountEmail: readSignedInEmail(deps),
			accountPicture: readSignedInPicture(deps),
			stateError: state.ok ? undefined : state.error,
		};
	}));

	ipcMain.handle(CHANNELS.command, guard(async (name: string, payload: Record<string, unknown> | undefined) => {
		if (typeof name !== 'string' || name.length === 0) {
			return { ok: false, error: 'the setup asked for nothing' };
		}
		const answer = await runHostCommand(deps, options.resources, options.connector, name, payload ?? {});
		return { ...answer, snapshot: answer.ok ? ((answer.data as { snapshot?: unknown } | undefined)?.snapshot) : undefined };
	}));

	ipcMain.handle(CHANNELS.finish, guard(async (result: { folder?: unknown; skipped?: unknown } | undefined) => {
		writeOnboardingFlag(onboardingDataDir(deps), deps.productService.version, deps.logService);
		const folder = typeof result?.folder === 'string' && result.folder.length > 0 ? result.folder : undefined;
		// The reply goes first; `finish` only hides the window, so the page is alive to receive it.
		setTimeout(() => options.finish({ folder }), 0);
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.chooseFolder, guard(async () => {
		const picked = await dialog.showOpenDialog(options.window, {
			title: 'Open a folder',
			properties: ['openDirectory', 'createDirectory'],
			buttonLabel: 'Open',
		});
		return { ok: true, path: picked.canceled ? undefined : picked.filePaths[0] };
	}));

	/**
	 * Starts a subscription sign-in.
	 *
	 * The child is plain node running pi over PiCode's profile, and it talks back in JSON lines:
	 * `event` (a URL, a device code, a progress line), `prompt` (a question with an id), and how it
	 * ended. The window answers by id. Nothing is inferred here — pi's own words are what travel.
	 */
	ipcMain.handle(CHANNELS.loginStart, guard(async (providerId: unknown) => {
		if (typeof providerId !== 'string' || providerId.length === 0) {
			return { ok: false, error: 'a sign-in needs a provider' };
		}
		stopLogin();
		announcedSignInAddresses.clear();
		const script = join(options.resources, 'host.cjs');
		const env: NodeJS.ProcessEnv = {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
			PICODE_ONBOARDING_CONNECTOR: options.connector,
			PICODE_ONBOARDING_DISTRIBUTION_ROOT: distributionRootOf(deps.environmentMainService),
			PICODE_ONBOARDING_PROFILE_DIR: internalProfileDir(deps),
			PICODE_ONBOARDING_USER_DATA: deps.environmentMainService.userDataPath,
		};
		const child = loginChild = spawn(process.execPath, [script, 'login', providerId], { env, windowsHide: true });
		const sender = options.window.webContents;
		const run = ++loginRun;
		const emit = (message: Record<string, unknown>): void => {
			if (!sender.isDestroyed()) {
				sender.send(CHANNELS.loginEvent, { ...message, run });
			}
		};
		let buffer = '';
		// Same rule as the one-shot path: marked lines are events, the rest is noise.
		const takeEvents = (chunk: string): void => {
			buffer += chunk;
			let index = buffer.indexOf('\n');
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf('\n');
				if (line.length === 0) {
					continue;
				}
				if (!line.startsWith(PROTOCOL_MARK)) {
					deps.logService.trace(`[picode-onboarding] sign-in: ${line.slice(0, 400)}`);
					continue;
				}
				try {
					const message = JSON.parse(line.slice(PROTOCOL_MARK.length)) as Record<string, unknown>;
					// The page may open exactly the sign-in address pi just announced, and no other.
					const announced = message['event'] as { type?: unknown; url?: unknown; verificationUri?: unknown } | undefined;
					for (const address of [announced?.url, announced?.verificationUri]) {
						if (typeof address === 'string' && address.startsWith('https://')) {
							announcedSignInAddresses.add(address);
						}
					}
					emit(message);
				} catch {
					// A line that cannot be read is not a reason to end somebody's sign-in.
				}
			}
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', takeEvents);
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => deps.logService.trace(`[picode-onboarding] sign-in (stderr): ${chunk.trim().slice(0, 400)}`));
		child.on('exit', () => {
			if (loginChild === child) {
				loginChild = undefined;
			}
			emit({ type: 'exit' });
		});
		return { ok: true, run };
	}));

	ipcMain.handle(CHANNELS.loginAnswer, guard(async (id: unknown, value: unknown) => {
		if (loginChild === undefined) {
			return { ok: false, error: 'the sign-in is not running' };
		}
		loginChild.stdin.write(`${JSON.stringify({ type: 'answer', id: String(id), value: typeof value === 'string' ? value : '' })}\n`);
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.loginCancel, guard(async () => {
		// The answer goes out first: a sign-in waiting on a browser poll has no prompt to reject,
		// so the window would otherwise sit on "waiting" for ever after a cancel.
		if (!options.window.isDestroyed()) {
			options.window.webContents.send(CHANNELS.loginEvent, { type: 'cancelled', run: loginRun });
		}
		stopLogin();
		return { ok: true };
	}));

	/**
	 * Signs in to PiCode **here**, not in the editor.
	 *
	 * The window starts a loopback listener, opens the browser, waits for the code and exchanges
	 * it, so the answer arrives while this window is still on screen. The code is handed back to
	 * the page and kept for the editor, which mints its own session from it at start (its token
	 * lives in secret storage this process does not own), without opening a second browser.
	 */
	// Signing out here signs the editor out too, now and not at its next start: the account lives in
	// the editor's own storage, the editor listens to it, and removing it is what both sides read as
	// "signed out".
	ipcMain.handle(CHANNELS.accountSignOut, guard(async () => {
		const storage = deps.applicationStorage;
		if (storage === undefined) {
			return { ok: false, error: 'the editor stores are not reachable' };
		}
		for (const key of [secretStorageKey('picode.account.refreshToken'), 'picode.account.uid', 'picode.account.email', 'picode.account.scopes', 'picode.account.picture']) {
			storage.remove(key, StorageScope.APPLICATION);
		}
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.accountCancel, guard(async () => {
		stopAccountSignIn?.();
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.accountSignIn, guard(async () => {
		const picode = deps.productService.picode;
		if (picode?.webOrigin === undefined) {
			return { ok: false, error: 'this build has no PiCode account configured' };
		}
		deps.logService.info('[picode-onboarding] sign-in: starting from the setup window');
		stopAccountSignIn = undefined;
		// The browser had focus while the owner approved; the window takes it back to show the result.
		const bringBack = (): void => {
			if (!options.window.isDestroyed()) {
				options.window.show();
				options.window.focus();
			}
		};
		const result = await signInFromSetup({
			onStart: (cancel, url) => {
				stopAccountSignIn = cancel;
				// The window shows the address, so a browser that opened behind everything can be
				// brought forward with one click instead of a second sign-in attempt.
				if (!options.window.isDestroyed()) {
					options.window.webContents.send(CHANNELS.accountEvent, { type: 'opening', url });
				}
			},
			webOrigin: picode.webOrigin,
			firebaseApiKey: picode.firebaseApiKey,
			openExternal: url => shell.openExternal(url),
			// Claimed for this executable right before the browser is sent away, so a stale entry
			// pointing at another copy cannot swallow the callback.
			registerProtocol: () => app.setAsDefaultProtocolClient(deps.productService.urlProtocol ?? 'picode', process.execPath, ['--open-url', '--']),
			log: line => deps.logService.info(line),
		});
		deps.logService.info(`[picode-onboarding] sign-in: ${result.ok ? `signed in as ${result.email ?? 'the account'}` : `did not finish (${result.error})`}`);
		if (result.ok && result.session !== undefined) {
			// In the background: the window answers as soon as the password is approved, and the
			// write either lands (storage was open) or is skipped with a line in the log.
			void storeEditorSession(deps, { ...result.session, picture: result.picture });
		}
		if (result.ok && result.session !== undefined) {
			// The session travels, not the code: the code was spent by the exchange above and is
			// single-use, so the editor could only reject it. This is what the editor itself stores.
			void runHostCommand(deps, options.resources, options.connector, 'setPendingSession', { session: result.session })
				.then(answer => {
					deps.logService.info(`[picode-onboarding] the editor session is saved for its next start: ${answer.ok ? 'yes' : `not saved (${answer.error})`}`);
				});
		}
		bringBack();
		// The code travels back to the window on purpose: it is what the editor redeems at start to
		// mint its own session. Without it the window can only *say* you are signed in, which is
		// exactly the bug this line fixes.
		return { ok: result.ok, email: result.email, picture: result.picture, plan: result.plan, code: result.code, error: result.error };
	}));

	ipcMain.handle(CHANNELS.openExternal, guard(async (url: unknown) => {
		if (!isOpenableAddress(url)) {
			return { ok: false, error: 'that address cannot be opened from here' };
		}
		await shell.openExternal(url as string);
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.copyText, guard(async (text: unknown) => {
		if (typeof text !== 'string' || text.length === 0 || text.length > 4000) {
			return { ok: false, error: 'there was nothing to copy' };
		}
		clipboard.writeText(text);
		return { ok: true };
	}));

	ipcMain.handle(CHANNELS.clone, guard(async (url: unknown) => {
		if (typeof url !== 'string' || !/^(https?:\/\/|git@)/.test(url.trim())) {
			return { ok: false, error: 'that is not a repository address' };
		}
		const picked = await dialog.showOpenDialog(options.window, {
			title: 'Choose where to clone',
			properties: ['openDirectory', 'createDirectory'],
			buttonLabel: 'Clone here',
		});
		if (picked.canceled || picked.filePaths.length === 0) {
			return { ok: false, error: 'cancelled' };
		}
		const target = picked.filePaths[0];
		try {
			// `git` from the machine, the same one the editor's own clone uses. No shell, so the
			// address is an argument and cannot become a command.
			await execFileAsync('git', ['clone', '--progress', url.trim(), target], { timeout: 600_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
			return { ok: true, path: target };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `git could not clone that repository: ${message}` };
		}
	}));

	return {
		dispose: () => {
			if (currentWindow === options.window) {
				stopLogin();
				unregisterIpc();
			}
		},
	};
}

/* ------------------------------------------------------------------ *
 * The gate the application calls
 * ------------------------------------------------------------------ */

/**
 * Decides whether the setup runs, runs it, and says what the editor should open afterwards.
 *
 * Skipped — silently and for free — when:
 *
 * - the flag says it is done and the version did not change;
 * - the start is not a plain one: `--agents`, a protocol URL, an extension test run or a CLI
 *   command all mean somebody asked for something specific, and a setup window in front of it
 *   would be in the way;
 * - the window is not installed.
 *
 * Never throws: the caller opens the editor with whatever comes back.
 */
export async function runOnboardingGate(deps: OnboardingDeps): Promise<OnboardingOutcome> {
	// The launch path asks this before opening a window for a `picode://` URL: while the setup is on
	// screen, an editor behind it is the glitch to avoid.
	registerSetupWindowState(() => currentWindow !== undefined && !currentWindow.isDestroyed());
	const args = deps.environmentMainService.args;
	if (args['agents'] || args.extensionTestsPath) {
		return {};
	}
	const reason = onboardingReason(readOnboardingFlag(onboardingDataDir(deps)), deps.productService.version);
	if (reason === undefined) {
		return {};
	}
	deps.logService.info(`[picode-onboarding] the setup runs (${reason})`);
	try {
		const result = await showOnboardingWindow(deps, reason);
		// Back to the event loop before the caller creates the editor's first window. The setup's
		// promise settles from inside the window's own `closed` event, and creating a BrowserWindow
		// there is re-entering the platform's window loop mid-destruction — measured: the whole
		// process died with an access violation, with nothing logged after it. One turn of the loop
		// is all it takes for the close to be over.
		await new Promise<void>(resolve => setImmediate(resolve));
		return result.folder !== undefined ? { folder: result.folder } : {};
	} catch (error) {
		deps.logService.warn('[picode-onboarding] the setup failed; opening the editor', error);
		return {};
	}
}

/** The setup window as the in-editor command opens it: same page, `setup` mode. */
export function openSetupWindowFromEditor(deps: OnboardingDeps): void {
	if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
		currentWindow.focus();
		return;
	}
	void showOnboardingWindow(deps, 'setup').catch(error => {
		deps.logService.warn('[picode-onboarding] the setup window could not be opened', error);
	});
}

