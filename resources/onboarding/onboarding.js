'use strict';

/*
 * The setup window's page.
 *
 * One page, three jobs: the first run, the run after a version upgrade, and "PiCode: Setup"
 * from inside the editor. The difference is `mode`, and what the page does with the state it is
 * given — the editor's current pi, model and theme arrive already filled in, so the page never
 * asks for something that is configured, and never writes over it without the owner clicking.
 *
 * The page decides nothing about disk. Every write is a named command the main process runs
 * through the connector's own backend (`host.cjs`), and every answer carries a fresh snapshot so
 * the page repaints from what is actually recorded rather than from what it hoped it wrote.
 */

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * One table per language, loaded from l10n/<code>.js (see index.html). English is the source and
 * the fallback for any key a language lacks, so a page with only some languages is still usable
 * without a language pack.
 *
 * A list stays a list: spreading English's arrays over the translation's would turn them into plain
 * objects, and the page destructures two of them (`layoutAgentZones`, `layoutEditorZones`) and maps
 * the other two. A language that left an item out gets the English one in its place.
 */
const STRINGS = window.PICODE_L10N;
for (const [code, table] of Object.entries(STRINGS)) {
	if (code === 'en') continue;
	for (const [key, value] of Object.entries(STRINGS.en)) {
		if (Array.isArray(value)) {
			const mine = Array.isArray(table[key]) ? table[key] : [];
			table[key] = value.map((item, index) => mine[index] ?? item);
		} else if (value && typeof value === 'object') {
			table[key] = { ...value, ...table[key] };
		}
	}
}

let language = 'en';

/** One word, from the current language; `{0}`, `{1}`… are filled from the extra arguments. */
function t(key, ...args) {
	const table = STRINGS[language] ?? STRINGS.en;
	const value = table[key] ?? STRINGS.en[key] ?? key;
	return typeof value === 'string' && args.length > 0 ? value.replace(/\{(\d+)\}/g, (whole, index) => String(args[Number(index)] ?? whole)) : value;
}

/**
 * The language the window opens in: the first of the system's languages that has a table
 * (`pt-BR` before `pt`, `zh-Hant-TW` as `zh-tw`), English when none does.
 */
function initialLanguage(languages = navigator.languages ?? [navigator.language]) {
	for (const raw of languages) {
		const parts = String(raw).toLowerCase().split('-');
		const region = parts.find((part, index) => index > 0 && part.length === 2);
		const script = parts.find((part, index) => index > 0 && part.length === 4);
		const candidates = [region && `${parts[0]}-${region}`, script === 'hant' ? 'zh-tw' : script === 'hans' ? 'zh-cn' : undefined, parts[0]];
		const match = candidates.find(code => code && STRINGS[code]);
		if (match) {
			return match;
		}
	}
	return 'en';
}

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

/**
 * The themes the cards show, with a palette measured from each theme's own colours.
 *
 * These are previews, not the theme engine: the editor paints the real thing when it opens, and
 * the window tints itself with the same handful of colours so picking one is not a guess.
 */
const THEMES = [
	// PiCode's own family first: these are the product's colours, and the editor defaults to
	// PiCode Dark when nobody has chosen (ThemeSettingDefaults in workbenchThemeService.ts).
	{ id: 'PiCode Dark', label: 'PiCode Dark', featured: true, dark: true, palette: { bg: '#050811', panel: '#080C17', fg: '#F3F4F6', line: '#111827', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#3B82F6' } },
	{ id: 'PiCode Light', label: 'PiCode Light', featured: true, dark: false, palette: { bg: '#F8FAFC', panel: '#F1F5F9', fg: '#0F172A', line: '#E2E8F0', keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', accent: '#0284C7' } },
	{ id: 'PiCode Neon Minimal', label: 'PiCode Neon Minimal', featured: true, dark: true, palette: { bg: '#05070B', panel: '#090D14', fg: '#E2E8F0', line: '#121A29', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#00F0FF' } },
	{ id: 'PiCode Slate', label: 'PiCode Slate', featured: true, dark: true, palette: { bg: '#15181D', panel: '#1A1F26', fg: '#E5E7EB', line: '#2A313B', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#38BDF8' } },
	{ id: 'PiCode Sepia', label: 'PiCode Sepia', featured: true, dark: false, palette: { bg: '#FBF7F0', panel: '#F5EFE4', fg: '#3B342B', line: '#E3D9C6', keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', accent: '#B45309' } },
	{ id: 'PiCode Synthwave', label: 'PiCode Synthwave', featured: false, dark: true, palette: { bg: '#14111E', panel: '#1A1628', fg: '#F8F8F2', line: '#2C2240', keyword: '#FF7EDB', string: '#FFCC66', comment: '#7B7BA8', accent: '#FF79C6' } },
	{ id: 'Dark Modern', label: 'Dark Modern', featured: true, dark: true, palette: { bg: '#1f1f1f', panel: '#262626', fg: '#cccccc', line: '#3c3c3c', keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', accent: '#0078d4' } },
	{ id: 'Monokai', label: 'Monokai', featured: true, dark: true, palette: { bg: '#272822', panel: '#2f302a', fg: '#f8f8f2', line: '#464741', keyword: '#f92672', string: '#e6db74', comment: '#75715e', accent: '#a6e22e' } },
	{ id: 'Quiet Light', label: 'Quiet Light', featured: true, dark: false, palette: { bg: '#f5f5f5', panel: '#ffffff', fg: '#333333', line: '#dcdcdc', keyword: '#4b83cd', string: '#448c27', comment: '#aaaaaa', accent: '#9760c4' } },
	{ id: 'Abyss', label: 'Abyss', featured: false, dark: true, palette: { bg: '#000c18', panel: '#0b1a2a', fg: '#6688cc', line: '#1d3a57', keyword: '#225588', string: '#22aa44', comment: '#384887', accent: '#4f9bd9' } },
	{ id: 'Dark+', label: 'Dark+', featured: false, dark: true, palette: { bg: '#1e1e1e', panel: '#252526', fg: '#d4d4d4', line: '#3c3c3c', keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', accent: '#0e639c' } },
	{ id: 'Solarized Dark', label: 'Solarized Dark', featured: false, dark: true, palette: { bg: '#002b36', panel: '#073642', fg: '#839496', line: '#0f4a58', keyword: '#859900', string: '#2aa198', comment: '#586e75', accent: '#268bd2' } },
	{ id: 'Tomorrow Night Blue', label: 'Tomorrow Night Blue', featured: false, dark: true, palette: { bg: '#002451', panel: '#00346e', fg: '#ffffff', line: '#0d4a86', keyword: '#ffeead', string: '#d1f1a9', comment: '#7285b7', accent: '#bbdaff' } },
	{ id: 'Light Modern', label: 'Light Modern', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f8f8f8', fg: '#3b3b3b', line: '#e5e5e5', keyword: '#0000ff', string: '#a31515', comment: '#008000', accent: '#005fb8' } },
	{ id: 'Light+', label: 'Light+', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f3f3f3', fg: '#000000', line: '#e5e5e5', keyword: '#0000ff', string: '#a31515', comment: '#008000', accent: '#007acc' } },
	{ id: 'Solarized Light', label: 'Solarized Light', featured: false, dark: false, palette: { bg: '#fdf6e3', panel: '#f7efdb', fg: '#657b83', line: '#e6ddc6', keyword: '#859900', string: '#2aa198', comment: '#93a1a1', accent: '#268bd2' } },
	{ id: 'Kimbie Dark', label: 'Kimbie Dark', featured: false, dark: true, palette: { bg: '#221a0f', panel: '#2b2115', fg: '#d3af86', line: '#42362a', keyword: '#98676a', string: '#889b4a', comment: '#a57a4c', accent: '#f06431' } },
	{ id: 'Red', label: 'Red', featured: false, dark: true, palette: { bg: '#390000', panel: '#440000', fg: '#f8f8f8', line: '#5a1010', keyword: '#ff9d00', string: '#a8ff60', comment: '#827c77', accent: '#ff2b2b' } },
	{ id: 'Default High Contrast', label: 'High Contrast', featured: false, dark: true, palette: { bg: '#000000', panel: '#0c0c0c', fg: '#ffffff', line: '#6fc3df', keyword: '#569cd6', string: '#ce9178', comment: '#7ca668', accent: '#1aebff' } },
	{ id: 'Default High Contrast Light', label: 'High Contrast Light', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f2f2f2', fg: '#292929', line: '#0f4a85', keyword: '#0f4a85', string: '#811f3f', comment: '#515151', accent: '#0f4a85' } },
];

/** The provider presets: addresses that answer, and the dialect each one speaks. */
const PROVIDER_PRESETS = [
	{ id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', mark: 'OR', keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', mark: 'DS', keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', api: 'openai-completions', mark: 'GQ', keyUrl: 'https://console.groq.com/keys' },
];

/**
 * Well-known model ids, offered **only when the provider actually returned them**.
 *
 * A recommendation that names a model the account cannot use is worse than no recommendation, so
 * this list is a filter over the answer, never a list of its own: whatever the endpoint did not
 * report simply is not shown.
 */
const RECOMMENDED_MODELS = [
	'anthropic/claude-sonnet-4',
	'anthropic/claude-3.5-sonnet',
	'openai/gpt-4o',
	'openai/gpt-4o-mini',
	'deepseek/deepseek-chat',
	'deepseek/deepseek-reasoner',
	'meta-llama/llama-3.3-70b-instruct',
	'qwen/qwen-2.5-72b-instruct',
	'llama-3.3-70b-versatile',
	'mistral-large-latest',
];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * The theme a new install starts in, and the one the editor falls back to when nothing is set
 * (`ThemeSettingDefaults` in workbenchThemeService.ts). The setup records it so the choice is
 * visible in the cards and in settings.json instead of being an implicit default.
 */
const DEFAULT_THEME = 'PiCode Dark';

const STEPS = ['welcome', 'layout', 'pi', 'model', 'theme', 'extras', 'done'];

const state = {
	/** How the editor's own language went: `ready`, `offline`… (the backend's word), until it is known. */
	languageOutcome: undefined,
	mode: 'first-run',
	version: '',
	snapshot: undefined,
	step: 0,
	/** Which pi the owner is pointing at, as the choice on screen (not yet written). */
	piChoice: 'internal',
	/** The provider form's current values. */
	provider: { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', key: '' },
	providerResult: undefined,
	providerError: undefined,
	/** Which provider the local-models tab is showing. */
	localProvider: undefined,
	/** What the local-models filter holds, so typing survives a repaint. */
	modelQuery: '',
	/** Which of the three ways in is on screen: `subscription`, `key` or `local`. */
	modelTab: 'subscription',
	/** Whether the API-key form shows the address/dialect fields as well. */
	advanced: false,
	subscriptions: undefined,
	subscriptionsLoading: false,
	subscriptionError: undefined,
	signIn: undefined,
	/** The last "Test connection" answer: what the address said, and how long it took. */
	probe: undefined,
	probeRunning: false,
	/** How much of the editor travels with a message (`picode.context.mode`). */
	contextMode: 'project',
	/** The model the owner picked, before it is written. */
	pickedModel: undefined,
	theme: undefined,
	/** How PiCode is laid out (`picode.appearance.layout`): `editor` unless agent was chosen. */
	layout: 'editor',
	showAllThemes: false,
	/** The three switches, as the editor has them in force; the backend says. */
	extras: { mcp: true, context: true, voice: false },
	/** Whether dictation exists for this system; the switch is offered only where it does. */
	voiceAvailable: false,
	packageQuery: '',
	packageRows: undefined,
	packageError: undefined,
	folder: undefined,
	/** The account card's own state: nothing yet, or the request left for the editor. */
	/** The account card: nothing yet, waiting in the browser, signed in, or the error. */
	account: { state: 'idle', email: undefined, error: undefined },
	/** How the last step will start: a folder, a clone, or nothing. */
	startKind: undefined,
	busy: '',
	notice: undefined,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);

/** One element, with attributes and children, without a template engine. */
function el(tag, attributes, ...children) {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes ?? {})) {
		if (value === undefined || value === false || value === null) {
			continue;
		}
		if (name === 'class') {
			node.className = value;
		} else if (name === 'text') {
			node.textContent = String(value);
		} else if (name === 'html') {
			node.innerHTML = value;
		} else if (name.startsWith('on') && typeof value === 'function') {
			node.addEventListener(name.slice(2).toLowerCase(), value);
		} else if (name === 'checked' || name === 'disabled' || name === 'selected') {
			node[name] = Boolean(value);
		} else {
			node.setAttribute(name, String(value));
		}
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) {
			continue;
		}
		node.append(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

/** Replaces a container's contents. */
function fill(node, ...children) {
	if (!node) {
		return;
	}
	// Painting a list again must not move the page: a choice repaints its step, and the person was
	// reading the bottom of it. The position is put back at once, and again after the next frame,
	// in case the browser settles the layout (or the focused card that was replaced) later.
	const scroller = node.closest('.steps-scroll');
	const top = scroller?.scrollTop;
	node.replaceChildren(...children.flat().filter(child => child !== undefined && child !== null && child !== false));
	if (scroller && top !== undefined && top > 0) {
		scroller.scrollTop = top;
		requestAnimationFrame(() => {
			scroller.scrollTop = top;
		});
	}
}

/** The snapshot, or an empty shape so the page can paint before the first answer. */
function snapshot() {
	return state.snapshot ?? { providers: [], packages: [], runtime: 'internal' };
}

/** Every model the profile declares, as `provider/model`. */
function modelRefs() {
	return providerList().flatMap(provider => provider.models.map(model => `${provider.id}/${model}`));
}

/** True when a usable model is recorded. */
function hasModel() {
	return typeof snapshot().defaultModel === 'string' && snapshot().defaultModel.length > 0;
}

/** Says something went wrong, in the header, without blocking the page. */
let noticeTimer;

/**
 * Says something that went wrong — once.
 *
 * An informational banner used to sit above the content for the rest of the session, following
 * the owner from step to step. It now has a close button, it leaves on its own, and moving to
 * another step takes it away: an alert is about the screen it appeared in.
 */
function setNotice(text, kind) {
	state.notice = text === undefined ? undefined : { text, kind: kind ?? 'info' };
	renderNotice();
	clearTimeout(noticeTimer);
	if (state.notice !== undefined && state.notice.kind !== 'error') {
		noticeTimer = setTimeout(() => setNotice(undefined), 9000);
	}
}

function renderNotice() {
	const node = $('notice');
	if (state.notice === undefined) {
		node.hidden = true;
		$('notice-text').textContent = '';
		return;
	}
	node.hidden = false;
	node.className = `notice ${state.notice.kind}`;
	$('notice-text').textContent = state.notice.text;
}

/** Runs an operation with the busy line on, and reports a failure instead of throwing. */
async function withBusy(label, operation) {
	state.busy = label;
	renderBusy();
	try {
		return await operation();
	} catch (error) {
		setNotice(`${t('errorTitle')}: ${error instanceof Error ? error.message : String(error)}`, 'error');
		return undefined;
	} finally {
		state.busy = '';
		renderBusy();
	}
}

function renderBusy() {
	const busy = $('busy');
	busy.hidden = state.busy.length === 0;
	$('busy-text').textContent = state.busy;
}

/** One backend command, with the answer's error turned into a sentence. */
async function command(name, payload) {
	const answer = await window.picode.command(name, payload);
	if (!answer || answer.ok !== true) {
		throw new Error(answer?.error ?? 'the setup could not complete that');
	}
	if (answer.snapshot) {
		adopt(answer.snapshot);
	}
	return answer;
}

/** Takes a fresh snapshot from disk as the truth. */
function adopt(next) {
	if (next === undefined || next === null) {
		return;
	}
	state.snapshot = next;
	state.theme = typeof next.theme === 'string' && next.theme.trim().length > 0 ? next.theme : DEFAULT_THEME;
	state.layout = next.layout === 'agent' ? 'agent' : 'editor';
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/**
 * Nothing repaints the window any more.
 *
 * It used to: picking a theme rewrote the whole palette, which was a nice trick and a bad idea
 * at the same time — the interface you are trying to read became the thing being previewed, and
 * a blue-on-blue theme made every label hard to find. The chrome now has one palette (the
 * product's), and a theme lives where a theme belongs: inside its card's code sample, in its own
 * colours, so the comparison is between the themes rather than between the window and itself.
 */

/**
 * Paints the window with a theme's own palette.
 *
 * It was removed for a while — "the chrome should not follow the theme, a blue-on-blue theme makes
 * labels hard to find" — and that was half right and half wrong: not following meant choosing a
 * theme was choosing a thumbnail, and the owner asked for the preview back. Following it is only
 * readable when the *whole* palette moves together, which is what this does: background, surface,
 * text, borders and accent, all from the theme's own colours.
 */
function paintTheme(palette) {
	const root = document.documentElement;
	root.style.setProperty('--bg', palette.bg);
	root.style.setProperty('--sidebar', palette.panel);
	root.style.setProperty('--panel', palette.panel);
	root.style.setProperty('--fg', palette.fg);
	root.style.setProperty('--line', palette.line);
	root.style.setProperty('--line-strong', palette.line);
	root.style.setProperty('--comment', palette.comment);
	root.style.setProperty('--fg-disabled', palette.comment);
	root.style.setProperty('--accent', palette.accent);
	root.style.setProperty('--accent-hover', palette.accent);
	root.style.setProperty('--accent-ink', palette.dark ? '#FFFFFF' : '#04121B');
	root.style.setProperty('--ok', palette.dark ? '#10B981' : '#0F7B4F');
	root.style.setProperty('--info', palette.accent);
	document.body.dataset.dark = palette.dark ? 'true' : 'false';
}

/** The palette to paint with: the theme in force, or the product's own before one is chosen. */
function paletteOf(id) {
	return THEMES.find(theme => theme.id === id)?.palette;
}

/** Puts the window back on the product palette (nothing chosen, or the pointer left the cards). */
function paintProductPalette() {
	const root = document.documentElement;
	for (const name of ['--bg', '--sidebar', '--panel', '--fg', '--line', '--line-strong', '--comment', '--fg-disabled', '--accent', '--accent-hover', '--accent-ink', '--ok', '--info']) {
		root.style.removeProperty(name);
	}
	document.body.dataset.dark = 'true';
}

/** The seven steps in the rail, with what is done and where we are. */
function renderRail() {
	const rail = $('steps');
	const items = STEPS.map((step, index) => {
		const done = index < state.step;
		const current = index === state.step;
		return el('button', {
			type: 'button',
			class: `step-link${current ? ' current' : ''}${done ? ' done' : ''}`,
			'aria-current': current ? 'step' : undefined,
			disabled: index > state.step,
			onclick: () => go(index),
		},
			el('span', { class: 'step-index', text: done ? '✓' : String(index + 1) }),
			el('span', { class: 'step-name', text: t('steps')[step] ?? step }),
		);
	});
	fill(rail, items);
	$('rail-subtitle').textContent = t('railSubtitle');
}

/** Which section is on screen, and what the footer says. */
/** The step last shown: only arriving at another one starts it at the top. */
let shownStep = -1;

function renderStep() {
	const name = STEPS[state.step];
	for (const section of document.querySelectorAll('.step')) {
		section.classList.toggle('active', section.dataset.step === name);
	}
	renderRail();
	renderFooter();
	if (shownStep !== state.step) {
		shownStep = state.step;
		document.querySelector('.steps-scroll')?.scrollTo?.({ top: 0 });
	}
}

function renderFooter() {
	const name = STEPS[state.step];
	const last = state.step === STEPS.length - 1;
	$('back').textContent = t('back');
	$('back').hidden = state.step === 0;
	$('next').textContent = last ? t('startCoding') : state.step === 0 ? t('getStarted') : t('next');
	// The model step is the one that can hold somebody up, and it says so with its own escape.
	let skipLabel = t('skip');
	if (name === 'model' && !hasModel()) {
		skipLabel = t('modelLater');
	} else if (name === 'extras') {
		skipLabel = t('skipExtras');
	} else if (name === 'done') {
		$('skip').hidden = true;
		$('next').disabled = false;
		return;
	}
	$('skip').hidden = false;
	$('skip').textContent = skipLabel;
	$('next').disabled = STEPS[state.step] === 'model' && !hasModel();
}

/* -- step 1: welcome ------------------------------------------------ */

function renderWelcome() {
	renderAccount();
	$('welcome-title').textContent = t('welcomeTitle');
	$('welcome-line').textContent = state.mode === 'update' ? t('welcomeUpdate') : state.mode === 'setup' ? t('welcomeSetup') : t('welcomeFirst');
	// The second line only belongs to a first run: the other two modes already say what they are.
	$('welcome-how').textContent = state.mode === 'first-run' ? t('welcomeHow') : '';
}

/**
 * The account card: one line of status, one action, no repetition.
 *
 * It used to say "waiting for the browser" twice — once as the status and again inside a disabled
 * primary button — which reads as a stuck interface. The waiting state now has the sentence once,
 * with a spinner, the instruction underneath, and a quiet way out; the signed-in state swaps the
 * badge and offers to sign out.
 */
function renderAccount() {
	const node = $('welcome-account');
	if (snapshot().accountAvailable !== true) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	const account = state.account;
	const signedIn = account.state === 'signed-in';

	// Signed in: a profile, not a paragraph. The avatar is the account's own picture when the
	// identity carries one, and the initials when it does not.
	const profile = signedIn ? el('div', { class: 'account-profile' },
		account.picture === undefined
			? el('span', { class: 'account-avatar', text: initialsOf(account.email) })
			: el('img', {
				class: 'account-avatar account-picture',
				src: account.picture,
				alt: '',
				// A profile picture is a remote file: if it does not arrive, the initials are still
				// an identity — a broken image icon is not.
				onerror: event => {
					const fallback = event.target.parentElement?.querySelector('.account-picture');
					if (fallback !== null && fallback !== undefined) {
						fallback.replaceWith(el('span', { class: 'account-avatar', text: initialsOf(account.email) }));
					}
				},
			}),
		el('div', { class: 'account-identity' },
			el('span', { class: 'account-name', text: account.email ?? t('accountTitle') }),
			el('span', { class: 'account-sub', text: t('accountSignedInShort') }),
		),
	) : undefined;

	const status = account.state === 'signed-out'
		? el('p', { class: 'account-line', text: t('accountSignOutQueued') })
		: account.state === 'waiting'
			? el('p', { class: 'account-line waiting' }, el('span', { class: 'spinner' }), t('accountWaiting'))
			: account.state === 'failed'
				? el('p', { class: 'account-line error', text: t('accountFailed', account.error ?? '?') })
				: signedIn ? undefined : el('p', { class: 'account-line', text: t('accountHow') });

	const action = signedIn
		? el('button', { type: 'button', class: 'secondary compact', onclick: () => signOutOfAccount() }, t('accountSignOut'))
		: account.state === 'waiting'
			? el('button', { type: 'button', class: 'link quiet', onclick: () => cancelAccountSignIn() }, t('accountCancel'))
			: el('button', {
				type: 'button', class: 'primary account-button',
				onclick: () => startAccountSignIn(),
			},
				el('span', { class: 'account-mark', text: '👤' }),
				el('span', { text: account.state === 'failed' ? t('accountRetry') : t('accountSignIn') }),
			);

	// Not signed in and not waiting: what the account is, and where the plans are.
	const signedOut = !signedIn && account.state !== 'waiting' && account.state !== 'signed-out';

	fill(node,
		el('div', { class: 'panel-head account-head' },
			el('span', { class: 'panel-title', text: t('accountTitle') }),
		),
		el('p', { class: 'account-line account-subtitle', text: t('accountWhy') }),
		profile,
		status,
		signedOut ? accountPerks() : undefined,
		account.state === 'waiting' ? el('p', { class: 'hint account-hint', text: t('accountWaitingWhy') }) : undefined,
		// Everything sits on the card's centre line: one action, or the waiting pair in a row.
		el('div', { class: 'account-actions' },
			// Waiting: the page first, the way out second, both on the centre line.
			account.state === 'waiting' && typeof account.url === 'string'
				? el('button', { type: 'button', class: 'secondary compact', onclick: () => window.picode.openExternal(account.url) }, t('accountReopen'))
				: undefined,
			action,
			signedOut ? el('button', { type: 'button', class: 'link quiet', onclick: () => window.picode.openExternal(PLANS_URL) }, t('accountPlans')) : undefined,
		),
	);
}

/** Where the plans are explained: the free account and what Pro adds. */
const PLANS_URL = 'https://www.getpicode.app/pricing';

/** What an account is, said once, in the states where a person has not signed in yet. */
function accountPerks() {
	return el('ul', { class: 'account-perks' },
		el('li', {}, el('span', { class: 'perk-mark', text: '\ud83c\udd93' }), el('span', { text: t('accountFree') })),
		el('li', {}, el('span', { class: 'perk-mark', text: '\u2601\ufe0f' }), el('span', { text: t('accountPro') })),
	);
}

/** Two letters for the avatar when the account carries no picture. */
function initialsOf(email) {
	const name = typeof email === 'string' && email.includes('@') ? email.slice(0, email.indexOf('@')) : (email ?? '');
	const parts = name.split(/[._-]/).filter(part => part.length > 0);
	const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
	return (letters || '?').toUpperCase();
}


/** Signs in for real: the browser opens now, and the card says what is happening. */
async function startAccountSignIn() {
	state.accountCancelled = false;
	state.account = { state: 'waiting', email: undefined, error: undefined, url: undefined };
	renderAccount();
	// The main process says which address it opened; the card offers it again, so a browser that
	// opened behind everything is one click away instead of a second attempt.
	const stopListening = window.picode.account.onEvent(message => {
		if (message?.type === 'opening' && typeof message.url === 'string') {
			state.account = { ...state.account, url: message.url };
			renderAccount();
		}
	});
	setTimeout(() => stopListening(), 60000);
	const result = await window.picode.account.signIn();
	// Cancelled while waiting: the answer that comes back is the cancellation itself, and it must
	// not turn into "authentication failed" on screen.
	if (state.accountCancelled === true) {
		return;
	}
	if (result?.ok === true) {
		state.account = { state: 'signed-in', email: result.email, picture: result.picture, error: undefined };
		// The session itself is stored by the main process (the code is spent by the exchange and
		// cannot be handed over); nothing to forward from here.
	} else {
		state.account = { state: 'failed', email: undefined, error: result?.error ?? t('errorTitle') };
	}
	renderAccount();
}

/** Stops waiting: the listener is closed and the card goes back to where it was. */
async function cancelAccountSignIn() {
	state.accountCancelled = true;
	state.account = { state: 'idle', email: undefined, error: undefined };
	renderAccount();
	try {
		await window.picode.account.cancel();
	} catch {
		// Nothing to cancel is not a failure worth a sentence.
	}
}

/**
 * Signs out for real: no code left here, and the editor drops its own session at start.
 *
 * The session lives in the editor's secret storage, which this window cannot reach — so it says
 * what it did ("your editor will finish it") instead of pretending the cookie is gone.
 */
async function signOutOfAccount() {
	state.account = { state: 'signed-out', email: undefined, error: undefined };
	renderAccount();
	try {
		// The running editor first: removing the account from its storage is what signs it out now.
		await window.picode.account.signOut();
		await command('clearPendingCode', {});
		await command('setAccountSignOut', {});
	} catch {
		// Nothing to clear is the same outcome.
	}
}

/* -- step 2: pi ---------------------------------------------------- */

function renderPi() {
	$('pi-title').textContent = t('piTitle');
	$('pi-lead').textContent = t('piLead');

	const data = snapshot();
	const internalVersion = data.internalPiVersion;
	const external = data.externalPi;

	const cards = [
		card({
			key: 'internal',
			title: t('piInternal'),
			badges: [t('piInternalRecommended')],
			why: t('piInternalWhy'),
			detail: internalVersion ? `${t('piInternalVersion')} ${internalVersion}` : undefined,
			available: true,
		}),
		card({
			key: 'external',
			title: t('piExternal'),
			badges: [t('piExternalReadOnly')],
			why: t('piExternalWhy'),
			detail: external ? `${t('piExternalFound')}${external.version ? ` · v${external.version}` : ''}` : t('piExternalMissing'),
			available: external !== undefined && external.hasProfile,
		}),
	];
	fill($('pi-cards'), cards);
	renderImport();
}

function card(options) {
	const chosen = state.piChoice === options.key;
	const disabled = options.available !== true;
	return el('button', {
		type: 'button',
		class: `card${chosen ? ' chosen' : ''}${disabled ? ' muted' : ''}`,
		disabled,
		onclick: () => choosePi(options.key),
	},
		el('div', { class: 'card-head' },
			el('span', { class: 'card-title', text: options.title }),
			...(options.badges ?? []).map(text => el('span', { class: 'badge', text })),
			chosen ? el('span', { class: 'badge ok', text: t('piChosen') }) : undefined,
		),
		el('p', { class: 'card-why', text: options.why }),
		options.detail ? el('p', { class: 'card-detail', text: options.detail }) : undefined,
	);
}

async function choosePi(key) {
	state.piChoice = key;
	renderPi();
	await withBusy('', async () => {
		await command('setRuntime', { runtime: key });
	});
	renderPi();
}

/**
 * The import card: only when there is another profile to bring something from, and only when
 * the pi in use is PiCode's own — importing into a profile that is not being read would leave
 * the panel showing one thing and pi running another.
 */
function renderImport() {
	const node = $('import-card');
	if (state.piChoice !== 'internal') {
		node.hidden = true;
		return;
	}
	node.hidden = false;
	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: `📥 ${t('impTitle')}` }),
		),
		el('p', { class: 'panel-hint', text: t('impWizardLead') }),
		el('div', { class: 'panel-actions' },
			el('button', { class: 'secondary', type: 'button', onclick: () => void openImportView({ embedded: true }) }, t('impOpen')),
		),
	);
}


/* -- step 3: model ------------------------------------------------- */

/**
 * The model step, as three tabs and one panel.
 *
 * It used to be three cards that each opened a block underneath, and two of them could be open at
 * once: the page grew taller than the window and the last panel slid under the footer. A tab bar
 * makes "one thing at a time" structural instead of a promise — every panel is shown by exactly
 * one tab, and switching closes the other.
 */
/**
 * The providers that can run models, as pi itself reports them once it has loaded.
 *
 * Until that answer arrives the ones the profile declares are shown. pi's answer is the truth: it
 * includes the providers a package brings (NAN) and the ones signed in with a subscription
 * (Anthropic), which no file declares, and it keeps each provider apart instead of reading a
 * model id's prefix as if it were one.
 */
function providerList() {
	const declared = snapshot().providers.map(provider => ({ ...provider, name: provider.id, subscription: false }));
	if (state.liveProviders === undefined) {
		return declared;
	}
	const live = state.liveProviders.map(provider => ({
		id: provider.id,
		name: provider.name ?? provider.id,
		models: provider.models,
		hasKey: true,
		subscription: provider.subscription === true,
	}));
	// pi only lists a provider that can run right now. One the profile declares (omni, a local
	// router that needs no key) is still the owner's provider, with its own models, so it stays.
	const seen = new Set(live.map(provider => provider.id));
	return [...live, ...declared.filter(provider => !seen.has(provider.id))];
}

/** Asks pi which providers can run models right now, once per change. */
async function loadProviders() {
	if (state.liveProviders !== undefined || state.liveProvidersLoading === true) {
		return;
	}
	state.liveProvidersLoading = true;
	try {
		const answer = await window.picode.command('availableProviders', {});
		if (Array.isArray(answer?.data)) {
			state.liveProviders = answer.data;
		}
	} catch {
		// The declared providers stay on screen; nothing is lost by pi not answering.
	} finally {
		state.liveProvidersLoading = false;
		renderModel();
		renderFooter();
	}
}

function renderModel() {
	if (state.liveProviders === undefined && state.liveProvidersLoading !== true) {
		void loadProviders();
	}
	$('model-title').textContent = t('modelTitle');
	$('model-lead').textContent = t('modelLead');

	const refs = modelRefs();
	// Nothing to show in "local" means the tab does not exist: a tab that opens an empty shelf is
	// a dead end with a label.
	if (state.modelTab === 'local' && refs.length === 0) {
		state.modelTab = 'subscription';
	}

	renderTabs(refs.length);
	renderStatus(refs.length);
	renderSubscriptions();
	renderProviderForm();
	renderLocal(refs);
	// Only while there is nothing connected, and not while the sign-in tab is saying it already.
	$('model-note').textContent = refs.length > 0 || state.modelTab === 'subscription' ? '' : t('modelSubscriptionNote');
}

/** The three ways in, as tabs with their counts. */
function renderTabs(localCount) {
	const tabs = [
		{ key: 'subscription', label: t('modelSubscription'), mark: '💳' },
		{ key: 'key', label: t('modelApiKey'), mark: '🔑' },
		{ key: 'local', label: t('modelLocal'), mark: '📦', count: localCount },
	];
	fill($('model-tabs'), tabs
		.filter(tab => tab.key !== 'local' || localCount > 0)
		.map(tab => el('button', {
			type: 'button',
			class: `tab${state.modelTab === tab.key ? ' chosen' : ''}`,
			role: 'tab',
			'aria-selected': state.modelTab === tab.key ? 'true' : 'false',
			onclick: () => {
				state.modelTab = tab.key;
				renderModel();
			},
		},
			el('span', { class: 'tab-mark', text: tab.mark }),
			el('span', { text: tab.label }),
			tab.key === 'local' ? el('span', { class: 'tab-count', text: String(localCount) }) : undefined,
		)));
}

/** What is already connected, on whichever tab you are standing. */
function renderStatus(localCount) {
	const node = $('model-status');
	const providers = providerList().filter(provider => provider.models.length > 0);
	if (providers.length === 0) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	fill(node,
		el('span', { class: 'dot ok' }),
		el('span', {
			text: `${t('modelConnected')} · ${countOf(localCount)} ${t('modelConnectedVia')} ${providers.map(provider => provider.name).join(', ')}`,
		}),
	);
}

function renderProviderForm() {
	const node = $('model-form');
	if (state.modelTab !== 'key') {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	const presets = PROVIDER_PRESETS.map(preset => el('button', {
		type: 'button',
		class: `preset${state.provider.id === preset.id ? ' chosen' : ''}`,
		onclick: () => {
			// A known provider fills its own address and dialect: asking for them is asking the
			// owner to type what the preset already knows.
			state.provider = { id: preset.id, endpoint: preset.endpoint, api: preset.api, key: state.provider.key };
			state.probe = undefined;
			renderModel();
		},
	}, el('span', { class: 'preset-mark', text: preset.mark }), el('span', { text: preset.label })));

	const field = (label, input) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
	const preset = PROVIDER_PRESETS.find(candidate => candidate.id === state.provider.id);
	const knownPreset = preset !== undefined && state.provider.endpoint === preset.endpoint;

	// The key comes from somewhere the owner has to go, and sending them there is the point.
	const keyLink = preset === undefined ? undefined : el('button', {
		type: 'button',
		class: 'link small',
		title: preset.keyUrl,
		onclick: async () => {
			const answer = await window.picode.openExternal(preset.keyUrl);
			if (answer?.ok !== true) {
				setNotice(answer?.error ?? t('errorTitle'), 'error');
			}
		},
	}, `${t('providerGetKey')} · ${preset.label}`);

	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: knownPreset ? `${t('modelApiKey')} · ${preset.label}` : t('modelApiKey') }),
			keyLink,
		),
		el('div', { class: 'presets' }, presets),
		// One field by default. The address, the dialect and the name are what a preset is for;
		// they are here for a local server or an endpoint nobody has heard of.
		// A short placeholder and the sentence underneath: a paragraph inside a one-line field is
		// what made the key row look like two texts stacked on each other.
		field(t('providerKey'), el('input', {
			type: 'password', value: state.provider.key, spellcheck: 'false', autocomplete: 'off',
			placeholder: 'sk-…',
			oninput: event => { state.provider.key = event.target.value; },
		})),
		el('p', { class: 'hint', text: t('providerKeyHint') }),
		state.advanced ? el('div', { class: 'fields' },
			field(t('providerName'), el('input', {
				type: 'text', value: state.provider.id, spellcheck: 'false',
				oninput: event => { state.provider.id = event.target.value; },
			})),
			field(t('providerEndpoint'), el('input', {
				type: 'text', value: state.provider.endpoint, spellcheck: 'false',
				oninput: event => { state.provider.endpoint = event.target.value; },
			})),
			field(t('providerDialect'), el('select', {
				onchange: event => { state.provider.api = event.target.value; },
			}, ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].map(api =>
				el('option', { value: api, selected: state.provider.api === api, text: api })))),
		) : undefined,
		el('button', {
			type: 'button',
			class: 'link small advanced-toggle',
			onclick: () => { state.advanced = !state.advanced; renderModel(); },
		}, state.advanced ? t('providerAdvancedHide') : t('providerAdvancedShow')),
		probeStatus(),
		state.providerError ? el('p', { class: 'hint error', text: state.providerError }) : undefined,
		el('div', { class: 'panel-actions' },
			el('button', { type: 'button', class: 'secondary', disabled: state.probeRunning, onclick: testProvider },
				state.probeRunning ? t('providerTesting') : t('providerTest')),
			el('button', { type: 'button', class: 'primary', onclick: connectProvider }, t('providerConnect')),
		),
		el('p', { class: 'hint', text: t('providerWait') }),
	);
}

/**
 * The providers a subscription can be opened for — asked of pi, not of a list we keep.
 *
 * The panel is the accordion: it is the same slot the API key uses, so opening one closes the
 * other and nothing is left holding empty space.
 */
function openSubscriptions() {
	state.modelTab = 'subscription';
	state.subscriptionError = undefined;
	renderModel();
}

/**
 * Asks pi which providers can be signed in to, once.
 *
 * The list belongs to a tab that is on screen from the start now, so it is asked for when the tab
 * paints — the same mistake the import card made: a panel that shows a spinner nothing ever
 * resolves is worse than one that asks.
 */
async function loadSubscriptions() {
	if (state.subscriptions !== undefined || state.subscriptionsLoading === true) {
		return;
	}
	state.subscriptionsLoading = true;
	try {
		const answer = await window.picode.command('subscriptions', {});
		state.subscriptions = Array.isArray(answer?.data) ? answer.data : [];
	} catch (error) {
		state.subscriptionError = error instanceof Error ? error.message : String(error);
	} finally {
		state.subscriptionsLoading = false;
		renderSubscriptions();
	}
}

function renderSubscriptions() {
	const node = $('model-subscriptions');
	if (state.modelTab !== 'subscription') {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	if (state.subscriptions === undefined && state.subscriptionsLoading !== true) {
		void loadSubscriptions();
	}

	const running = state.signIn;
	const list = (state.subscriptions ?? []).map(provider => el('button', {
		type: 'button',
		class: 'provider-row',
		disabled: running !== undefined && running.running === true,
		onclick: () => startSignIn(provider.id),
	},
		el('span', { class: 'provider-text' },
			el('span', { class: 'provider-name', text: provider.name }),
			provider.note === undefined ? undefined : el('span', { class: 'provider-note', text: provider.note }),
		),
		el('span', { class: provider.signedIn === true ? 'provider-go ok' : 'provider-go', text: provider.signedIn === true ? `✓ ${t('subSignedIn')}` : t('subSignIn') }),
	));

	const live = running === undefined ? undefined : el('div', { class: 'signin' },
		el('p', { class: 'signin-state' },
			running.finished === true
				? el('span', { class: 'dot ok' })
				: el('span', { class: 'dot pending' }),
			running.message ?? t('subWaiting'),
		),
		running.url === undefined ? undefined : el('button', {
			type: 'button', class: 'link small', onclick: () => window.picode.openExternal(running.url),
		}, t('subOpen')),
		running.code === undefined ? undefined : el('p', { class: 'signin-code' },
			el('span', { class: 'field-label', text: t('subCode') }),
			el('code', { text: running.code }),
		),
		running.prompt === undefined ? undefined : renderPrompt(running.prompt),
		running.running === true ? el('div', { class: 'panel-actions' },
			el('button', { type: 'button', class: 'secondary', onclick: () => window.picode.signIn.cancel() }, t('subCancel')),
		) : undefined,
	);

	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: t('subTitle') }),
		),
		el('p', { class: 'panel-hint', text: t('subLead') }),
		state.subscriptionError === undefined ? undefined : el('p', { class: 'hint error', text: state.subscriptionError }),
		state.subscriptions === undefined ? el('p', { class: 'hint', text: t('subLoading') })
			: state.subscriptions.length === 0 ? el('p', { class: 'hint', text: t('subNone') })
				: el('div', { class: 'providers' }, list),
		live,
	);
}

/** One of pi's questions, as a field the page can answer. */
function renderPrompt(prompt) {
	const send = value => {
		void window.picode.signIn.answer(prompt.id, value);
		// Answered: the question leaves the panel, so only what pi says next is left to wait on.
		if (state.signIn?.prompt?.id === prompt.id) {
			state.signIn = { ...state.signIn, prompt: undefined };
			renderSubscriptions();
		}
	};
	if (prompt.type === 'select') {
		return el('label', { class: 'field' },
			el('span', { class: 'field-label', text: prompt.message }),
			// A select that already shows its first option never fires `change` when the owner picks
			// that same option, so pi would wait forever for an answer. A blank first entry keeps every
			// real option, the default included, one choice away from sending.
			el('select', { onchange: event => { if (event.target.value !== '') { send(event.target.value); } } },
				[el('option', { value: '', text: t('subChoose'), selected: true, disabled: true }),
					...(prompt.options ?? []).map(option => el('option', { value: option.id, text: option.label }))]),
		);
	}
	return el('div', { class: 'field' },
		el('span', { class: 'field-label', text: prompt.message }),
		el('div', { class: 'clone' },
			el('input', {
				type: prompt.type === 'secret' ? 'password' : 'text',
				placeholder: prompt.placeholder ?? '',
				onkeydown: event => {
					if (event.key === 'Enter') {
						send(event.target.value);
					}
				},
			}),
			el('button', {
				type: 'button', class: 'secondary',
				onclick: event => send(event.target.parentElement.querySelector('input').value),
			}, t('next')),
		),
	);
}

/** Starts pi's own sign-in and follows it, event by event. */
async function startSignIn(providerId) {
	state.signIn = { running: true, message: t('subWaiting') };
	state.subscriptionError = undefined;
	renderSubscriptions();
	let run;
	const subscription = window.picode.signIn.onEvent(message => {
		// Events from an attempt that is no longer the one on screen are not ours to act on.
		if (run !== undefined && message.run !== undefined && message.run !== run) {
			return;
		}
		const current = state.signIn ?? { running: true };
		if (message.type === 'event') {
			const event = message.event ?? {};
			if (event.type === 'auth_url') {
				state.signIn = { ...current, url: event.url, message: event.instructions ?? t('subWaiting') };
				void window.picode.openExternal(event.url);
			} else if (event.type === 'device_code') {
				state.signIn = { ...current, code: event.userCode, url: event.verificationUri, message: event.instructions ?? t('subWaiting') };
				void window.picode.openExternal(event.verificationUri);
			} else {
				state.signIn = { ...current, message: event.message ?? current.message };
			}
			renderSubscriptions();
			return;
		}
		if (message.type === 'prompt') {
			// "How do you want to sign in?" always has an answer already: the browser one, which pi
			// marks as its default. Nobody should have to pick it, so it is sent straight away and
			// the question never reaches the screen.
			const options = message.prompt?.options ?? [];
			const preferred = message.prompt?.type === 'select'
				? (options.find(option => /\(default\)/i.test(option.label ?? '')) ?? options.find(option => /browser/i.test(option.label ?? '')))
				: undefined;
			if (preferred !== undefined) {
				void window.picode.signIn.answer(message.id, preferred.id);
				return;
			}
			state.signIn = { ...current, prompt: { id: message.id, ...message.prompt } };
			renderSubscriptions();
			return;
		}
		if (message.type === 'done') {
			state.signIn = { ...current, running: false, finished: true, prompt: undefined, message: t('subDone') };
			subscription();
			void refreshAfterSignIn();
			return;
		}
		if (message.type === 'cancelled' || message.type === 'exit') {
			// `exit` is the safety net: whatever ended the child, the panel must stop saying it
			// is still waiting.
			state.signIn = { ...current, running: false, prompt: undefined, message: message.type === 'cancelled' ? t('subCancelled') : (current.message ?? t('subCancelled')) };
			subscription();
			renderSubscriptions();
			return;
		}
		if (message.type === 'error') {
			state.signIn = { ...current, running: false, message: undefined };
			state.subscriptionError = `${t('subFailed')}: ${message.message ?? ''}`;
			subscription();
			renderSubscriptions();
		}
	});
	const started = await window.picode.signIn.start(providerId);
	run = started?.run;
}

/** After a sign-in the profile has new models: ask again, and offer them. */
async function refreshAfterSignIn() {
	// A sign-in changes both lists: which providers can run models, and which rows say "Signed in".
	state.liveProviders = undefined;
	state.subscriptions = undefined;
	await withBusy('', async () => {
		const answer = await window.picode.command('state', {});
		if (answer?.data) {
			adopt(answer.data);
		}
	});
	renderModel();
	renderFooter();
}

/**
 * The models in the profile: **provider first, then its models**.
 *
 * A profile may declare one provider whose model ids carry their own namespaces — the one in front
 * of me has a single `omni` whose 165 models are `NAN-…`, `nan-providers/…`, `auto/…`, `nvidia/…`.
 * Showing that as one flat list mixes families that belong nowhere near each other, and showing
 * only `omni` hides the very families somebody is looking for. So the first dropdown lists the
 * provider **and each of its namespaces as its own entry** — `omni`, `omni › NAN`, `omni ›
 * nan-providers` — and the second holds only that entry's models.
 *
 * Nothing is renamed or moved on disk: this is a view over what pi reports. A namespace is a
 * group of model ids, and the label says whose they are.
 */
function renderLocal(refs) {
	const node = $('model-local');
	if (state.modelTab !== 'local' || refs.length === 0) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;

	const entries = providerEntries();
	const current = snapshot().defaultModel;
	// A default model whose provider is not in the profile is a model the editor cannot run. It is
	// not this window's job to choose one, but it is its job to say so instead of showing a list
	// that never mentions it.
	const allRefs = entries.length > 0 ? entries[0] === undefined ? [] : providerList().flatMap(provider => provider.models.map(model => `${provider.id}/${model}`)) : [];
	state.staleModel = typeof current === 'string' && current.length > 0 && !allRefs.includes(current)
		? t('modelStale', current)
		: undefined;
	if (state.localProvider === undefined || !entries.some(entry => entry.key === state.localProvider)) {
		// Start where the owner already is: the narrowest entry that holds the default model, so the
		// dropdown opens on the family in use instead of on a list of 165.
		const holders = entries.filter(entry => typeof current === 'string' && entry.models.some(model => `${entry.provider}/${model}` === current));
		state.localProvider = (holders.length === 0 ? entries[0] : holders.reduce((narrowest, entry) => (entry.models.length <= narrowest.models.length ? entry : narrowest)))?.key;
	}
	const entry = entries.find(candidate => candidate.key === state.localProvider);
	const entryRefs = entry === undefined ? [] : entry.models.map(model => `${entry.provider}/${model}`);
	const selected = entryRefs.includes(state.pickedModel) ? state.pickedModel : (entryRefs.includes(current) ? current : entryRefs[0]);
	if (selected !== undefined) {
		state.pickedModel = selected;
	}

	fill(node,
		el('label', { class: 'field' },
			el('span', { class: 'field-label', text: t('modelPickProvider') }),
			el('select', {
				onchange: event => {
					// A model belongs to its entry: switching clears the pick.
					state.localProvider = event.target.value;
					state.pickedModel = undefined;
					renderModel();
				},
			}, entries.map(candidate => el('option', {
				value: candidate.key,
				selected: candidate.key === state.localProvider,
				text: candidate.label,
			}))),
		),
		(snapshot().orphanCredentials ?? []).length === 0 ? undefined : el('p', { class: 'hint' },
			`${t('modelOrphan')} (${snapshot().orphanCredentials.join(', ')})`),
		state.staleModel === undefined ? undefined : el('p', { class: 'hint error', text: state.staleModel }),
		el('label', { class: 'field' },
			el('span', { class: 'field-label', text: t('modelNewConversations') }),
			el('select', {
				onchange: event => { state.pickedModel = event.target.value; },
			}, entryRefs.toSorted((left, right) => left.localeCompare(right)).map(ref =>
				el('option', { value: ref, selected: ref === selected, text: ref }))),
		),
		el('p', { class: 'hint', text: t('modelAgentsNote') }),
		el('div', { class: 'panel-actions' },
			el('button', {
				type: 'button', class: 'secondary',
				disabled: selected === undefined,
				onclick: async () => {
					const chosen = $('model-local').querySelectorAll('select')[1];
					if (chosen === undefined) {
						return;
					}
					await withBusy('', async () => { await command('setModel', { ref: chosen.value }); });
					renderModel();
					renderFooter();
				},
			}, t('modelSaveDefault')),
		),
	);
}

/** `1 model` / `2 models`, in the language on screen. */
function countOf(models) {
	return `${models} ${models === 1 ? t('modelWord') : t('modelCount')}`;
}

/**
 * The provider dropdown's entries: one per provider, with the models it really offers.
 *
 * A provider is what pi reports as one. A model id's prefix (`NAN-…`, `auto/…`) is not a provider,
 * so omni lists only omni's models, NAN appears when the NAN package brings it, and a subscription
 * (Anthropic) appears once it is signed in.
 */
function providerEntries() {
	return providerList()
		.filter(candidate => candidate.models.length > 0)
		.map(provider => {
			const models = provider.models.map(model => (typeof model === 'string' ? model : String(model)));
			const note = provider.subscription ? ` · ${t('subSignedIn')}` : provider.hasKey ? '' : ` · ${t('modelNoKey')}`;
			return {
				key: provider.id,
				provider: provider.id,
				label: `${provider.name} · ${countOf(models.length)}${note}`,
				models,
			};
		});
}

/* -- step 4: theme ------------------------------------------------- */

function renderLayout() {
	$('layout-title').textContent = t('layoutTitle');
	$('layout-lead').textContent = t('layoutLead');
	fill($('layout-grid'), ['agent', 'editor'].map(layoutCard));
}

function renderTheme() {
	$('theme-title').textContent = t('themeTitle');
	$('theme-lead').textContent = t('themeLead');
	const shown = THEMES.filter(theme => state.showAllThemes || theme.featured);
	fill($('theme-grid'), shown.map(themeCard));
	$('theme-all').textContent = state.showAllThemes ? t('themeFewer') : t('themeAll');
}

function themeCard(theme) {
	const chosen = state.theme === theme.id;
	return el('button', {
		type: 'button',
		class: `theme-card${chosen ? ' chosen' : ''}`,
		title: t('themeTry'),
		onmouseenter: () => paintTheme(theme.palette),
		onmouseleave: () => { const inForce = paletteOf(state.theme); if (inForce) { paintTheme(inForce); } else { paintProductPalette(); } },
		onfocus: () => paintTheme(theme.palette),
		onblur: () => { const inForce = paletteOf(state.theme); if (inForce) { paintTheme(inForce); } else { paintProductPalette(); } },
		onclick: () => chooseTheme(theme),
	},
		el('div', {
			class: 'theme-preview',
			style: `background:${theme.palette.bg};border-color:${theme.palette.line}`,
			html: [
				`<span style="color:${theme.palette.comment}">// hello</span>`,
				`<span style="color:${theme.palette.keyword}">const</span> <span style="color:${theme.palette.fg}">pi</span> <span style="color:${theme.palette.keyword}">=</span> <span style="color:${theme.palette.string}">'picode'</span>`,
				`<span style="color:${theme.palette.keyword}">function</span> <span style="color:${theme.palette.fg}">chat</span><span style="color:${theme.palette.comment}">() {</span>`,
				`  <span style="color:${theme.palette.keyword}">return</span> <span style="color:${theme.palette.string}">"hola"</span>`,
				`<span style="color:${theme.palette.comment}">}</span>`,
			].join('<br>'),
		}),
		el('div', { class: 'theme-name' },
			el('span', { text: theme.label }),
			chosen ? el('span', { class: 'badge ok', text: '✓' }) : undefined,
		),
	);
}

/**
 * One layout, as a card that explains itself: a small window with its three zones named, a line
 * saying who it suits, and three points on what goes where.
 */
function layoutCard(layout) {
	const chosen = state.layout === layout;
	const agent = layout === 'agent';
	const [left, centre, right] = t(agent ? 'layoutAgentZones' : 'layoutEditorZones');
	const zone = (name, label) => el('span', { class: `layout-zone ${name}` }, el('span', { class: 'layout-zone-label', text: label }));
	const preview = agent
		? el('div', { class: 'layout-preview agent' }, zone('side', left), zone('main', centre), zone('side', right))
		: el('div', { class: 'layout-preview editor' }, zone('side', left), el('span', { class: 'layout-stack' }, zone('main', centre), zone('bottom', t('layoutEditorBottom'))), zone('side', right));
	return el('button', {
		type: 'button',
		class: `layout-card${chosen ? ' chosen' : ''}`,
		'aria-pressed': chosen ? 'true' : 'false',
		onclick: () => chooseLayout(layout),
	},
		preview,
		el('div', { class: 'layout-head' },
			el('span', { class: 'layout-title' },
				el('span', { class: 'layout-name', text: agent ? `🤖 ${t('layoutAgent')}` : `💻 ${t('layoutEditor')}` }),
				// The new way of working says so; the one everybody knows does not need to.
				agent ? el('span', { class: 'badge new', text: t('layoutNew') }) : undefined,
			),
			chosen ? el('span', { class: 'badge ok', text: '✓' }) : undefined,
		),
		el('span', { class: 'layout-note', text: agent ? t('layoutAgentNote') : t('layoutEditorNote') }),
		el('ul', { class: 'layout-points' }, ...t(agent ? 'layoutAgentPoints' : 'layoutEditorPoints').map(point => el('li', { text: point }))),
	);
}

async function chooseLayout(layout) {
	state.layout = layout;
	renderLayout();
	await withBusy('', async () => { await command('setLayout', { layout }); });
}

async function chooseTheme(theme) {
	state.theme = theme.id;
	paintTheme(theme.palette);
	renderTheme();
	await withBusy('', async () => { await command('setTheme', { id: theme.id }); });
}

/* -- step 5: extras ----------------------------------------------- */

/** Gentle's two preferences, read once from the profile the editor will use. */
async function loadGentle() {
	if (state.gentle !== undefined || state.gentleLoading === true) {
		return;
	}
	state.gentleLoading = true;
	try {
		const answer = await window.picode.command('gentle', {});
		if (answer?.data) {
			state.gentle = answer.data;
		}
	} catch {
		// The panel simply does not show: the preferences stay what Gentle has on disk.
	} finally {
		state.gentleLoading = false;
		renderExtras();
	}
}

async function chooseGentle(key, value) {
	await withBusy('', async () => {
		const answer = await command('setGentle', { key, value });
		if (answer?.data) {
			state.gentle = answer.data;
		}
	});
	renderExtras();
}

/** One group of cards for one Gentle preference, in the same shape as the context cards. */
function gentleChoice(title, key, current, options) {
	return el('div', { class: 'panel' },
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: title }),
		),
		el('div', { class: 'modes', role: 'radiogroup', 'aria-label': title },
			options.map(option => {
				const chosen = current === option.value;
				return el('button', {
					type: 'button',
					class: `mode${chosen ? ' chosen' : ''}`,
					role: 'radio',
					'aria-checked': chosen ? 'true' : 'false',
					onclick: () => chooseGentle(key, option.value),
				},
					el('span', { class: 'mode-head' },
						el('span', { class: 'mode-mark', text: option.mark }),
						el('strong', { text: option.title }),
						chosen ? el('span', { class: 'mode-check', text: '✓' }) : undefined,
					),
					el('span', { class: 'mode-why', text: option.why }),
				);
			})),
	);
}

function renderExtras() {
	if (state.gentle === undefined && state.gentleLoading !== true) {
		void loadGentle();
	}
	$('extras-title').textContent = t('extrasTitle');
	$('extras-lead').textContent = t('extrasLead');
	const toggle = (key, title, why) => el('label', { class: 'switch' },
		el('span', { class: 'switch-text' },
			el('strong', { text: title }),
			el('span', { class: 'switch-why', text: why }),
		),
		el('input', {
			type: 'checkbox',
			checked: state.extras[key] === true,
			onchange: async event => {
				state.extras[key] = event.target.checked;
				await withBusy('', async () => { await command('setExtras', { values: { [key]: event.target.checked } }); });
				renderExtras();
			},
		}),
	);

	// One control, not two. It used to be a switch *and* three cards: with the switch off the
	// cards were disabled and nobody could tell which of the two was in charge. The cards are the
	// control; choosing one is what turns the context on.
	const modes = [
		{ key: 'project', title: t('contextProject'), why: t('contextProjectWhy'), mark: '📂', badge: t('contextRecommended') },
		{ key: 'file', title: t('contextFile'), why: t('contextFileWhy'), mark: '📄' },
		{ key: 'selection', title: t('contextSelection'), why: t('contextSelectionWhy'), mark: '🔒' },
	];

	fill($('extras-list'),
		el('div', { class: 'panel' },
			toggle('mcp', t('extraMcp'), t('extraMcpWhy')),
		),
		state.voiceAvailable ? el('div', { class: 'panel' },
			toggle('voice', t('extraVoice'), t('extraVoiceWhy')),
		) : undefined,
		el('div', { class: 'panel' },
			el('div', { class: 'panel-head' },
				el('span', { class: 'panel-title', text: t('contextTitle') }),
			),
			el('p', { class: 'panel-hint', text: t('contextLead') }),
			el('div', { class: 'modes', role: 'radiogroup', 'aria-label': t('contextTitle') },
				modes.map(mode => {
					const chosen = state.contextMode === mode.key;
					return el('button', {
						type: 'button',
						class: `mode${chosen ? ' chosen' : ''}`,
						role: 'radio',
						'aria-checked': chosen ? 'true' : 'false',
						onclick: () => chooseContextMode(mode.key),
					},
						el('span', { class: 'mode-head' },
							el('span', { class: 'mode-mark', text: mode.mark }),
							el('strong', { text: mode.title }),
							mode.badge === undefined ? undefined : el('span', { class: 'badge ok', text: mode.badge }),
							chosen ? el('span', { class: 'mode-check', text: '✓' }) : undefined,
						),
						el('span', { class: 'mode-why', text: mode.why }),
					);
				})),
			state.extras.context === false
				? el('p', { class: 'hint' }, t('contextOffNote'))
				: undefined,
		),
		state.gentle === undefined ? undefined : el('div', { class: 'panels' },
			el('p', { class: 'panel-hint', text: `${t('gentleTitle')} · ${t('gentleLead')}` }),
			gentleChoice(t('gentlePersonaTitle'), 'persona', state.gentle.persona, [
				{ value: 'gentleman', title: t('personaGentleman'), why: t('personaGentlemanWhy'), mark: '🎩' },
				{ value: 'neutral', title: t('personaNeutral'), why: t('personaNeutralWhy'), mark: '🧭' },
			]),
			gentleChoice(t('gentlePermissionsTitle'), 'permissions', state.gentle.permissions, [
				{ value: 'normal', title: t('permissionsNormal'), why: t('permissionsNormalWhy'), mark: '🛡️' },
				{ value: 'auto', title: t('permissionsAuto'), why: t('permissionsAutoWhy'), mark: '⚙️' },
				{ value: 'yolo', title: t('permissionsYolo'), why: t('permissionsYoloWhy'), mark: '🚀' },
			]),
		),
	);

	// `pi packages` is not here any more: it is a shelf you browse, not a question a first run has
	// to answer, and it lives where it belongs (Agent Customizations → Packages, in the editor).
}

/**
 * Picks one of the three, and makes sure the context is **on**.
 *
 * The product keeps two settings: whether any context travels (`picode.context.attach`) and how
 * much (`picode.context.mode`). This step shows the second one only — so choosing a card also
 * turns the first one on. Without that, a card could look selected while nothing was attached,
 * which is exactly the confusion the switch caused.
 */
async function chooseContextMode(mode) {
	const wasOff = state.extras.context !== true;
	state.contextMode = mode;
	state.extras.context = true;
	renderExtras();
	await withBusy('', async () => {
		await command('setContextMode', { mode });
		if (wasOff) {
			await command('setExtras', { values: { context: true } });
		}
	});
	renderExtras();
}

/* -- step 6: ready -------------------------------------------------- */

/**
 * Three ways to begin, and one question.
 *
 * The final screen used to compete with itself: suggested prompts, a folder button, a clone box
 * and the primary button all at once. It now asks the only question that matters here — where do
 * you want to start — and the primary button stays the one way out.
 *
 * The starter prompts are gone from this window on purpose: they belong in the chat, next to the
 * project they talk about, not in a setup screen that cannot see it yet.
 */
async function chooseStart(kind) {
	if (kind === 'folder') {
		const answer = await window.picode.chooseFolder();
		if (answer?.path) {
			state.folder = answer.path;
			state.startKind = 'folder';
		}
	} else if (kind === 'clone') {
		state.startKind = 'clone';
	} else {
		state.folder = undefined;
		state.startKind = 'blank';
	}
	renderDone();
}

function renderDone() {
	$('done-title').textContent = t('doneTitle');
	$('done-lead').textContent = t('doneLead');
	$('done-start-title').textContent = t('startTitle');
	$('clone').textContent = t('clone');
	$('pro-note').textContent = t('proNote');

	// One question, three answers — each a card, and the picked one says so.
	const starts = [
		{ kind: 'folder', title: t('startFolder'), why: t('startFolderWhy'), mark: '📂' },
		{ kind: 'clone', title: t('startClone'), why: t('startCloneWhy'), mark: '🐙' },
		{ kind: 'blank', title: t('startBlank'), why: t('startBlankWhy'), mark: '⚡' },
	];
	fill($('start-cards'), starts.map(start => el('button', {
		type: 'button',
		class: `card start-card${state.startKind === start.kind ? ' chosen' : ''}`,
		onclick: () => chooseStart(start.kind),
	},
		el('div', { class: 'card-head' },
			el('span', { class: 'start-mark', text: start.mark }),
			el('span', { class: 'card-title', text: start.title }),
		),
		el('p', { class: 'card-why', text: start.why }),
	)));

	// The clone address only exists when cloning is the answer: no box waiting to be filled in.
	const cloning = state.startKind === 'clone';
	$('clone-row').hidden = !cloning;
	$('start-hint').textContent = state.folder === undefined
		? (cloning ? '' : t('startHint'))
		: `${t('folderChosen')} ${state.folder}`;

	const data = snapshot();
	const piValue = data.runtime === 'external' ? (data.externalPi?.version ? `${t('externalShort')} · ${data.externalPi.version}` : t('externalShort')) : `${t('internalShort')}${data.internalPiVersion ? ` · ${data.internalPiVersion}` : ''}`;
	const rows = [
		[t('welcomeFactsPi'), piValue],
		[t('welcomeFactsModel'), hasModel() ? snapshot().defaultModel : t('modelNothingYet')],
		[t('layoutFact'), state.layout === 'agent' ? t('layoutAgent') : t('layoutEditor')],
		...(languageRow() ? [languageRow()] : []),
		[t('welcomeFactsTheme'), state.theme ?? t('notSet')],
	];
	fill($('done-summary'), rows.map(([label, value]) => el('div', { class: 'summary-row' },
		el('span', { class: 'summary-label', text: label }),
		el('span', { class: 'summary-value', text: value }),
	)));
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function go(index) {
	if (index < 0 || index >= STEPS.length) {
		return;
	}
	state.step = index;
	// An alert belongs to the screen that raised it.
	setNotice(undefined);
	renderStep();
	renderCurrent();
}

function renderCurrent() {
	const name = STEPS[state.step];
	if (name === 'welcome') {
		renderWelcome();
	} else if (name === 'layout') {
		renderLayout();
	} else if (name === 'pi') {
		renderPi();
	} else if (name === 'model') {
		renderModel();
	} else if (name === 'theme') {
		renderTheme();
	} else if (name === 'extras') {
		renderExtras();
	} else if (name === 'done') {
		renderDone();
	}
	renderFooter();
}

/** The last step's primary action: record the setup and let the editor open. */
async function finish(skipped) {
	await withBusy('', async () => {
		await window.picode.finish({ skipped: skipped === true, folder: state.folder });
	});
}

$('next').addEventListener('click', async () => {
	if (state.step === STEPS.length - 1) {
		await finish(false);
		return;
	}
	go(state.step + 1);
});
$('back').addEventListener('click', () => go(state.step - 1));
$('skip').addEventListener('click', async () => {
	// "Skip" on the model step means "later, not now" and moves on; anywhere else it leaves.
	if (STEPS[state.step] === 'model') {
		go(state.step + 1);
		return;
	}
	await finish(true);
});
$('notice-close').addEventListener('click', () => setNotice(undefined));
$('theme-all').addEventListener('click', () => {
	state.showAllThemes = !state.showAllThemes;
	renderTheme();
});
$('clone').addEventListener('click', async () => {
	const url = $('clone-url').value.trim();
	if (url.length === 0) {
		return;
	}
	await withBusy(t('cloning'), async () => {
		const answer = await window.picode.clone(url);
		if (answer?.ok === true && answer.path) {
			state.folder = answer.path;
		} else if (answer?.error && answer.error !== 'cancelled') {
			setNotice(answer.error, 'error');
		}
	});
	renderDone();
});

document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		finish(true);
	}
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/** Switches the whole page's words, and repaints what is on screen. */
function setLanguage(next) {
	language = next;
	paintLanguage();
	document.documentElement.lang = next;
	renderStep();
	renderCurrent();
}

/** The country's flag for a language, as a small vector image: emoji flags are only letters on Windows. */
function flagOf(code) {
	const flag = el('span', { class: 'flag', 'aria-hidden': 'true' });
	flag.innerHTML = window.PICODE_FLAGS?.[code] ?? '';
	return flag;
}

/** The button shows the language in use, flag first; the list marks it too. */
function paintLanguage() {
	fill($('language'),
		flagOf(language),
		el('span', { class: 'lang-name', text: STRINGS[language]?.language ?? language }),
		el('span', { class: 'lang-caret', 'aria-hidden': 'true', text: '\u25be' }),
	);
	for (const item of document.querySelectorAll('#language-list [role="option"]')) {
		item.setAttribute('aria-selected', String(item.dataset.code === language));
	}
}

/**
 * One entry per table, each with its flag and named in its own language so it can be found by
 * someone who cannot read the page. A list of our own rather than a `select`: the browser's list
 * cannot hold a picture, and it opens upward here, where the footer is.
 */
function fillLanguages() {
	const button = $('language');
	const list = $('language-list');
	const codes = Object.keys(STRINGS).sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : STRINGS[a].language.localeCompare(STRINGS[b].language)));
	const close = refocus => {
		list.hidden = true;
		button.setAttribute('aria-expanded', 'false');
		if (refocus) {
			button.focus();
		}
	};
	const choose = code => {
		close(true);
		if (typeof code === 'string' && code !== language) {
			setLanguage(code);
			void prepareLanguage(code);
		}
	};
	fill(list, codes.map(code => el('li', {
		role: 'option',
		'data-code': code,
		tabindex: '-1',
		onclick: () => choose(code),
	}, flagOf(code), el('span', { class: 'lang-name', text: STRINGS[code].language }))));
	const options = () => [...list.querySelectorAll('[role="option"]')];
	button.addEventListener('click', () => {
		if (!list.hidden) {
			close(false);
			return;
		}
		list.hidden = false;
		button.setAttribute('aria-expanded', 'true');
		(list.querySelector(`[data-code="${language}"]`) ?? options()[0])?.focus();
	});
	list.addEventListener('keydown', event => {
		const all = options();
		const at = all.indexOf(document.activeElement);
		const move = index => {
			all[Math.max(0, Math.min(all.length - 1, index))]?.focus();
			event.preventDefault();
		};
		if (event.key === 'ArrowDown') {
			move(at + 1);
		} else if (event.key === 'ArrowUp') {
			move(at - 1);
		} else if (event.key === 'Home') {
			move(0);
		} else if (event.key === 'End') {
			move(all.length - 1);
		} else if (event.key === 'Enter' || event.key === ' ') {
			choose(document.activeElement?.dataset?.code);
			event.preventDefault();
		} else if (event.key === 'Escape') {
			close(true);
			event.preventDefault();
		} else if (event.key === 'Tab') {
			close(false);
		}
	});
	document.addEventListener('click', event => {
		if (!list.hidden && !$('lang').contains(event.target)) {
			close(false);
		}
	});
	paintLanguage();
}

/**
 * Gets the editor's own language ready in the background: the language pack is downloaded while
 * the steps go by, and the editor installs it at its first start. Silent when it cannot: the
 * editor opens in the language it has, and the summary says so only at the end.
 */
async function prepareLanguage(code) {
	state.languageOutcome = undefined;
	try {
		const answer = await command('prepareLanguage', { language: code, label: STRINGS[code]?.language ?? code, firstRun: state.mode === 'first-run' });
		if (code === language) {
			state.languageOutcome = answer.data?.language;
			renderCurrent();
		}
	} catch {
		// Nothing to say: the editor still opens.
	}
}

/** The summary's language row: said only while the editor still has to change, or could not get its pack. */
function languageRow() {
	const name = STRINGS[language]?.language ?? language;
	if (state.languageOutcome === 'ready') {
		return [t('languageFact'), `${name} \u00b7 ${t('languageReady')}`];
	}
	if (state.languageOutcome === 'offline') {
		return [t('languageFact'), `${name} \u00b7 ${t('languageOffline')}`];
	}
	return undefined;
}

async function main() {
	fillLanguages();
	setLanguage(initialLanguage());

	// The setup window used to keep its own idea of the session; now it follows the shared one, so a
	// sign-in or a sign-out in the editor shows here immediately (and the reverse is pushed the
	// other way by the same file).
	window.picode.account.onState(message => {
		const email = typeof message?.email === 'string' ? message.email : '';
		// Ignore the echo of our own state: the card already shows it, and repainting would drop
		// the "waiting" spinner mid-flow.
		if (state.account.state === 'waiting') {
			return;
		}
		const signedIn = email.length > 0;
		const already = state.account.state === 'signed-in';
		const picture = typeof message?.picture === 'string' && message.picture.length > 0 ? message.picture : undefined;
		if (signedIn === already && (state.account.email ?? '') === email && (signedIn ? state.account.picture === picture || picture === undefined : true)) {
			return;
		}
		state.account = signedIn
			? { state: 'signed-in', email, picture: typeof message?.picture === 'string' && message.picture.length > 0 ? message.picture : undefined, error: undefined }
			: { state: 'idle', email: undefined, error: undefined };
		renderAccount();
		if (signedIn) {
			setNotice(t('accountEditorSignedIn', email), 'info');
		}
	});
	try {
		const boot = await window.picode.bootstrap();
		// The computer's language, from the system itself: the browser here speaks the editor's.
		if (Array.isArray(boot.systemLanguages) && boot.systemLanguages.length > 0) {
			const detected = initialLanguage(boot.systemLanguages);
			if (detected !== language) {
				setLanguage(detected);
			}
		}
		state.mode = boot.mode ?? 'first-run';
		document.body.dataset.mode = state.mode;
		state.version = boot.version ?? '';
		if (typeof boot.accountEmail === 'string' && boot.accountEmail.length > 0) {
			state.account = { state: 'signed-in', email: boot.accountEmail, picture: boot.accountPicture || undefined, error: undefined };
		}
		if (boot.snapshot) {
			adopt(boot.snapshot);
			if (!boot.snapshot.theme) {
				// Nothing chosen yet: PiCode Dark is the product default, so record it now. This is
				// what makes the card show as chosen and the welcome say the theme, and it keeps
				// the editor on the brand palette instead of an unset setting.
				await command('setTheme', { id: DEFAULT_THEME }).catch(() => undefined);
			}
			if (state.mode === 'first-run' && boot.snapshot.layout !== 'agent') {
				// A first setup recommends the new layout: Agent is marked from the start and recorded,
				// so leaving the step alone (or skipping the setup) keeps it. The other modes keep
				// whatever the person has.
				await command('setLayout', { layout: 'agent' }).catch(() => undefined);
			}
			state.piChoice = boot.snapshot.runtime === 'external' ? 'external' : 'internal';
			// The extras start from what is recorded, so the switches tell the truth.
			// The switches show what the editor will actually do, defaults included.
			if (boot.snapshot.extras) {
				state.extras = { ...state.extras, ...boot.snapshot.extras };
			}
			state.voiceAvailable = boot.snapshot.voiceAvailable === true;
			if (typeof boot.snapshot.contextMode === 'string') {
				state.contextMode = boot.snapshot.contextMode;
			}
		}
		if (boot.stateError) {
			setNotice(boot.stateError, 'error');
		}
	} catch (error) {
		setNotice(`${t('errorTitle')}: ${error instanceof Error ? error.message : String(error)}`, 'error');
	}

	// Always the welcome. Skipping it because "everything is configured" hid where you were and what
	// the setup had read — the welcome already shows that (pi, model, theme) and every fact there is
	// a shortcut to its step. Arriving mid-flow, at step 2, felt like a form that had lost its start.
	go(0);
	void prepareLanguage(language);
	// Opened by the editor's Import command: that view is the whole window.
	if (state.mode === 'import') {
		void openImportView({ embedded: false });
	}
}

main();
