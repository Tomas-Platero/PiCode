'use strict';

/*
 * The setup window's page.
 *
 * One page, four jobs: the first run, the run after a version upgrade, "PiCode: Setup" from inside
 * the editor, and the Import view on its own. The difference is `mode`, and what the page does with
 * the state it is given — the editor's current pi, model and theme arrive already filled in, so the
 * page never asks for something that is configured, and never writes over it without a click.
 *
 * The page decides nothing about disk. Every write is a named command the main process runs
 * through the connector's own backend (`host.cjs`), and every answer carries a fresh snapshot so
 * the page repaints from what is actually recorded rather than from what it hoped it wrote.
 *
 * Painting: every change of state calls `render()`, which builds the step again as plain elements
 * and *patches* them onto what is on screen (`patch`). Nodes that are still there are kept, so a
 * field keeps its focus and its caret, and a list keeps its scroll; only what changed is touched.
 */

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * One table per language, loaded from l10n/<code>.js (see index.html). English is the source and
 * the fallback for any key a language lacks.
 *
 * A list stays a list: spreading English's arrays over the translation's would turn them into plain
 * objects. A language that left an item out gets the English one in its place.
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
 * Fixed data
 * ------------------------------------------------------------------ */

/**
 * The themes the cards show, with a palette measured from each theme's own colours.
 *
 * These are previews, not the theme engine: the editor paints the real thing when it opens. The
 * preview pane beside the grid uses the same handful of colours, so picking one is not a guess.
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

/** The API-key presets: addresses that answer, and the dialect each one speaks. */
const PROVIDER_PRESETS = [
	{ id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', api: 'openai-completions', keyUrl: 'https://console.groq.com/keys' },
];

/** The dialects pi can speak to an address (`ProviderRequest.api` in onboarding-host.ts). */
const PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];

/** Where each provider's mark comes from; anything else gets its initials on a colour. */
const PROVIDER_DOMAINS = {
	'openai-codex': 'openai.com',
	openai: 'openai.com',
	anthropic: 'anthropic.com',
	'github-copilot': 'github.com',
	xai: 'x.ai',
	'kimi-coding': 'moonshot.ai',
	openrouter: 'openrouter.ai',
	deepseek: 'deepseek.com',
	groq: 'groq.com',
	meta: 'meta.com',
	radius: 'radius.dev',
};

/** Marks drawn in dark ink, which disappear on the dark setup unless inverted. */
const DARK_INK = new Set(['github.com', 'radius.dev']);

/**
 * The theme a new install starts in, and the one the editor falls back to when nothing is set
 * (`ThemeSettingDefaults` in workbenchThemeService.ts). The setup records it so the choice is
 * visible in the cards and in settings.json instead of being an implicit default.
 */
const DEFAULT_THEME = 'PiCode Dark';

/** Where the plans are explained: the free account and what Pro adds. */
const PLANS_URL = 'https://www.getpicode.app/pricing';

/** How long the browser gets to come back by itself before pasting is offered. */
const PASTE_FALLBACK_MS = 30000;

const STEPS = ['welcome', 'layout', 'agent', 'look', 'done'];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
	mode: 'first-run',
	version: '',
	snapshot: undefined,
	step: 0,
	/** The steps already shown, which the rail marks as seen. */
	visited: new Set([0]),
	/** Which pi runs (`picode.pi.runtime`), as the choice on screen. */
	piChoice: 'internal',
	piAdvancedOpen: false,
	/** What pi reports as able to run models; `undefined` until it answers. */
	liveProviders: undefined,
	liveProvidersLoading: false,
	subscriptions: undefined,
	subscriptionsLoading: false,
	subscriptionError: undefined,
	/** The subscription sign-in in progress, if any. */
	signIn: undefined,
	pasteTimer: undefined,
	/** What the provider search holds. */
	providerQuery: '',
	/** The provider row that is open: `live:<id>`, `sub:<id>` or `key:<id>` (`key:custom` for an address). */
	openProvider: undefined,
	/** The API-key form of the open row. */
	provider: { id: '', endpoint: '', api: 'openai-completions', key: '' },
	providerAdvanced: false,
	probe: undefined,
	probeRunning: false,
	connecting: false,
	providerError: undefined,
	/** One line saying what the last action on the model changed. */
	modelNote: undefined,
	/** The model picked in each provider's row, before it is saved. */
	pickedModel: {},
	theme: undefined,
	/** The theme under the pointer (or the keyboard), shown in the preview pane. */
	previewTheme: undefined,
	showAllThemes: false,
	/** How PiCode is laid out (`picode.appearance.layout`). */
	layout: 'editor',
	/** The switches, as the editor has them in force; the backend says. */
	extras: { mcp: true, context: true, voice: false },
	voiceAvailable: false,
	/** How much of the editor travels with a message (`picode.context.mode`). */
	contextMode: 'project',
	gentle: undefined,
	gentleLoading: false,
	advancedOpen: false,
	folder: undefined,
	/** How the editor will start: a folder, a clone, or nothing. */
	startKind: undefined,
	cloneUrl: '',
	/** The account card: idle, waiting in the browser, signed in, signed out, or failed. */
	account: { state: 'idle', email: undefined, error: undefined },
	accountCancelled: false,
	/** How the editor's own language went: `ready`, `offline`… (the backend's word), until it is known. */
	languageOutcome: undefined,
	busy: '',
	notice: undefined,
};

/* ------------------------------------------------------------------ *
 * Elements, and patching them onto the page
 * ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);

const HANDLERS = Symbol('handlers');
const BOUND = Symbol('bound');

/**
 * Binds one dispatcher per event type and node; the handler it calls lives in `node[HANDLERS]`, so
 * a patch can hand an existing node the handlers of the node that replaced it.
 */
function bind(node, type) {
	node[BOUND] ??= new Set();
	if (!node[BOUND].has(type)) {
		node[BOUND].add(type);
		node.addEventListener(type, event => node[HANDLERS]?.[type]?.(event));
	}
}

/**
 * One element, with attributes and children, without a template engine.
 *
 * `key` names a node among its siblings so a patch finds it again; `value` and `checked` are
 * properties, not attributes; `html` sets the markup (only ever built here, from our own data).
 */
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
		} else if (name === 'key') {
			node.setAttribute('data-key', String(value));
		} else if (name === 'value') {
			node.__value = String(value);
		} else if (name === 'checked') {
			node.__checked = Boolean(value);
			node.checked = Boolean(value);
		} else if (name.startsWith('on') && typeof value === 'function') {
			const type = name.slice(2).toLowerCase();
			node[HANDLERS] ??= {};
			node[HANDLERS][type] = value;
			bind(node, type);
		} else if (value === true) {
			node.setAttribute(name, '');
		} else {
			node.setAttribute(name, String(value));
		}
	}
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) {
			continue;
		}
		node.append(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	if (node.__value !== undefined) {
		node.value = node.__value;
	}
	return node;
}

function keyOf(node) {
	return node.nodeType === 1 ? (node.getAttribute('data-key') ?? undefined) : undefined;
}

function sameKind(a, b) {
	if (a.nodeType !== b.nodeType) {
		return false;
	}
	if (a.nodeType !== 1) {
		return true;
	}
	return a.nodeName === b.nodeName && a.getAttribute('type') === b.getAttribute('type') && keyOf(a) === keyOf(b);
}

/** Brings an existing node in line with a freshly built one, keeping its identity. */
function update(old, next) {
	if (old.nodeType !== 1) {
		if (old.nodeValue !== next.nodeValue) {
			old.nodeValue = next.nodeValue;
		}
		return;
	}
	for (const { name, value } of [...next.attributes]) {
		if (old.getAttribute(name) !== value) {
			old.setAttribute(name, value);
		}
	}
	for (const { name } of [...old.attributes]) {
		if (!next.hasAttribute(name)) {
			old.removeAttribute(name);
		}
	}
	old[HANDLERS] = next[HANDLERS];
	for (const type of Object.keys(next[HANDLERS] ?? {})) {
		bind(old, type);
	}
	patch(old, [...next.childNodes]);
	if (next.__checked !== undefined && old.checked !== next.__checked) {
		old.checked = next.__checked;
	}
	old.__value = next.__value;
	// A field being typed in is its own truth: its `oninput` already wrote the state it came from.
	if (next.__value !== undefined && old.value !== next.__value && document.activeElement !== old) {
		old.value = next.__value;
	}
}

/**
 * Puts `next` inside `parent`, reusing what is already there.
 *
 * Keyed children are matched by key, the rest in order by tag; a matched node is updated in place
 * (so focus, caret, scroll and loaded images survive), anything new is inserted, and what is left
 * over is removed.
 */
function patch(parent, next) {
	const wanted = next.flat(Infinity)
		.filter(child => child !== undefined && child !== null && child !== false)
		.map(child => (typeof child === 'string' ? document.createTextNode(child) : child));
	const byKey = new Map();
	const loose = [];
	for (const node of parent.childNodes) {
		const key = keyOf(node);
		if (key === undefined) {
			loose.push(node);
		} else {
			byKey.set(key, node);
		}
	}
	let cursor = 0;
	const result = wanted.map(node => {
		const key = keyOf(node);
		let match;
		if (key !== undefined) {
			match = byKey.get(key);
			byKey.delete(key);
		} else {
			for (let index = cursor; index < loose.length; index++) {
				if (sameKind(loose[index], node)) {
					match = loose[index];
					cursor = index + 1;
					break;
				}
			}
		}
		if (match !== undefined && sameKind(match, node)) {
			update(match, node);
			return match;
		}
		return node;
	});
	result.forEach((node, index) => {
		const at = parent.childNodes[index];
		if (at !== node) {
			parent.insertBefore(node, at ?? null);
		}
	});
	while (parent.childNodes.length > result.length) {
		parent.lastChild.remove();
	}
}

/** Replaces a container's contents (the Import view and the language list paint with this). */
function fill(node, ...children) {
	if (node) {
		patch(node, children);
	}
}

/* ------------------------------------------------------------------ *
 * Talking to the backend
 * ------------------------------------------------------------------ */

/** The snapshot, or an empty shape so the page can paint before the first answer. */
function snapshot() {
	return state.snapshot ?? { providers: [], packages: [], runtime: 'internal', orphanCredentials: [] };
}

function hasModel() {
	return typeof snapshot().defaultModel === 'string' && snapshot().defaultModel.length > 0;
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

let noticeTimer;

/**
 * Says something that went wrong — once. It has a close button, it leaves on its own (errors
 * stay until closed), and moving to another step takes it away.
 */
function setNotice(text, kind) {
	state.notice = text === undefined ? undefined : { text, kind: kind ?? 'info' };
	clearTimeout(noticeTimer);
	if (state.notice !== undefined && state.notice.kind !== 'error') {
		noticeTimer = setTimeout(() => setNotice(undefined), 9000);
	}
	renderNotice();
}

/** Runs an operation with the busy line on, and reports a failure instead of throwing. */
async function withBusy(label, operation) {
	state.busy = label;
	renderBusy();
	try {
		return await operation();
	} catch (error) {
		setNotice(`${t('errorTitle')}: ${messageOf(error)}`, 'error');
		return undefined;
	} finally {
		state.busy = '';
		renderBusy();
	}
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * The frame: rail, notice, footer
 * ------------------------------------------------------------------ */

/** What each step holds right now, in a few words, and whether it wants a look. */
function stepStatus(step) {
	if (step === 'welcome') {
		return { text: state.account.state === 'signed-in' ? t('accountSignedInShort') : t('railOptional') };
	}
	if (step === 'layout') {
		return { text: state.layout === 'agent' ? t('layoutAgent') : t('layoutEditor') };
	}
	if (step === 'agent') {
		if (!hasModel()) {
			return { text: t('railNoModel'), attention: true };
		}
		const ref = snapshot().defaultModel;
		return { text: ref.slice(ref.lastIndexOf('/') + 1) };
	}
	if (step === 'look') {
		return { text: themeById(state.theme)?.label ?? state.theme };
	}
	return { text: undefined };
}

function renderRail() {
	patch($('steps'), STEPS.map((step, index) => {
		const current = index === state.step;
		const seen = state.visited.has(index) && !current;
		const status = stepStatus(step);
		const attention = status.attention === true && seen;
		return el('button', {
			type: 'button',
			key: step,
			class: `step-link${current ? ' current' : ''}${seen ? ' seen' : ''}${attention ? ' attention' : ''}`,
			'aria-current': current ? 'step' : undefined,
			onclick: () => go(index),
		},
			el('span', { class: 'step-index', 'aria-hidden': 'true', text: attention ? '!' : seen ? '✓' : String(index + 1) }),
			el('span', { class: 'step-text' },
				el('span', { class: 'step-name', text: t('steps')[step] ?? step }),
				status.text ? el('span', { class: 'step-state', text: status.text }) : undefined,
			),
		);
	}));
	$('rail-subtitle').textContent = t('railSubtitle');
	$('steps').setAttribute('aria-label', t('railSubtitle'));
}

function renderNotice() {
	const node = $('notice');
	node.hidden = state.notice === undefined;
	node.className = `notice ${state.notice?.kind ?? ''}`;
	$('notice-text').textContent = state.notice?.text ?? '';
	$('notice-close').title = t('dismiss');
}

function renderBusy() {
	$('busy').hidden = state.busy.length === 0;
	$('busy-text').textContent = state.busy;
}

/** One meaning for Skip: open the editor now, keeping whatever has been chosen. */
function renderFooter() {
	const last = state.step === STEPS.length - 1;
	$('back').textContent = t('back');
	$('back').hidden = state.step === 0;
	$('next').textContent = last ? t('startCoding') : state.step === 0 ? t('getStarted') : t('next');
	$('skip').hidden = last;
	$('skip').textContent = t('skip');
	$('skip').title = t('skipWhy');
}

/** The step last painted: only arriving at another one starts at the top and moves the focus. */
let shownStep = -1;

const VIEWS = {
	welcome: welcomeView,
	layout: layoutView,
	agent: agentView,
	look: lookView,
	done: doneView,
};

/** Paints everything from `state`. Cheap: only what changed is touched. */
function render() {
	const name = STEPS[state.step];
	for (const section of document.querySelectorAll('.step')) {
		const active = section.dataset.step === name;
		section.classList.toggle('active', active);
		section.hidden = !active;
		if (active) {
			patch(section, VIEWS[name]());
		}
	}
	renderRail();
	renderFooter();
	renderNotice();
	renderBusy();
	if (shownStep !== state.step) {
		const arrived = shownStep !== -1;
		shownStep = state.step;
		document.querySelector('.steps-scroll')?.scrollTo?.({ top: 0 });
		// The heading takes the focus, so a screen reader says where we are and Tab starts at the top.
		if (arrived) {
			document.querySelector('.step.active .step-title')?.focus({ preventScroll: true });
		}
	}
}

/* ------------------------------------------------------------------ *
 * Step 1: welcome
 * ------------------------------------------------------------------ */

function welcomeView() {
	const line = state.mode === 'update' ? t('welcomeUpdateMode') : state.mode === 'setup' ? t('welcomeSetup') : t('welcomeFirst');
	return [
		el('div', { class: 'welcome' },
			el('img', { class: 'welcome-mark', src: 'media/picode.svg', alt: '' }),
			el('h1', { class: 'step-title', tabindex: '-1', text: t('welcomeTitle') }),
			el('p', { class: 'lead', text: line }),
			state.mode === 'first-run' ? el('p', { class: 'lead-sub', text: t('welcomeHow') }) : undefined,
			accountCard(),
			// Importing fills PiCode's own profile, so it is offered only while that is the one in use.
			state.piChoice === 'internal' ? el('button', {
				type: 'button',
				key: 'import',
				class: 'import-action',
				onclick: () => void openImportView({ embedded: true }),
			},
				el('span', { class: 'import-mark', 'aria-hidden': 'true', text: '📥' }),
				el('span', { class: 'import-text' },
					el('strong', { text: t('impOpenWelcome') }),
					el('span', { text: t('impWelcomeHint') }),
				),
				el('span', { class: 'import-go', 'aria-hidden': 'true', text: '→' }),
			) : undefined,
		),
	];
}

/** The account card: one line of status, one action, no repetition. */
function accountCard() {
	if (snapshot().accountAvailable !== true) {
		return undefined;
	}
	const account = state.account;
	const signedIn = account.state === 'signed-in';
	const waiting = account.state === 'waiting';
	const signedOut = !signedIn && !waiting && account.state !== 'signed-out';

	const avatar = account.picture === undefined
		? el('span', { class: 'account-avatar', text: initialsOf(account.email) })
		: el('img', {
			class: 'account-avatar',
			src: account.picture,
			alt: '',
			// A remote picture that does not arrive falls back to the initials, not a broken icon.
			onerror: () => {
				state.account = { ...state.account, picture: undefined };
				render();
			},
		});

	const status = account.state === 'signed-out'
		? el('p', { class: 'account-line', text: t('accountSignOutQueued') })
		: waiting
			? el('p', { class: 'account-line waiting' }, el('span', { class: 'spinner' }), t('accountWaiting'))
			: account.state === 'failed'
				? el('p', { class: 'account-line error', text: t('accountFailed', account.error ?? '?') })
				: undefined;

	return el('div', { class: 'panel account-card', key: 'account' },
		el('div', { class: 'panel-head account-head' },
			el('span', { class: 'panel-title', text: t('accountTitle') }),
		),
		signedIn ? el('div', { class: 'account-profile' },
			avatar,
			el('div', { class: 'account-identity' },
				el('span', { class: 'account-name', text: account.email ?? t('accountTitle') }),
				el('span', { class: 'account-sub', text: t('accountSignedInShort') }),
			),
		) : el('p', { class: 'account-line', text: t('accountWhy') }),
		status,
		signedOut ? el('ul', { class: 'account-perks' },
			el('li', {}, el('span', { class: 'perk-mark', text: '🆓' }), el('span', { text: t('accountFree') })),
			el('li', {}, el('span', { class: 'perk-mark', text: '☁️' }), el('span', { text: t('accountPro') })),
		) : undefined,
		waiting ? el('p', { class: 'hint', text: t('accountWaitingWhy') }) : undefined,
		el('div', { class: 'account-actions' },
			waiting && typeof account.url === 'string'
				? el('button', { type: 'button', class: 'secondary compact', onclick: () => window.picode.openExternal(account.url) }, t('accountReopen'))
				: undefined,
			signedIn
				? el('button', { type: 'button', class: 'secondary compact', onclick: () => signOutOfAccount() }, t('accountSignOut'))
				: waiting
					? el('button', { type: 'button', class: 'link quiet', onclick: () => cancelAccountSignIn() }, t('accountCancel'))
					: el('button', { type: 'button', class: 'primary account-button', onclick: () => startAccountSignIn() },
						el('span', { 'aria-hidden': 'true', text: '👤' }),
						el('span', { text: account.state === 'failed' ? t('accountRetry') : t('accountSignIn') }),
					),
			signedOut ? el('button', { type: 'button', class: 'link quiet', onclick: () => window.picode.openExternal(PLANS_URL) }, t('accountPlans')) : undefined,
		),
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
	render();
	// The main process says which address it opened; the card offers it again, so a browser that
	// opened behind everything is one click away instead of a second attempt.
	const stopListening = window.picode.account.onEvent(message => {
		if (message?.type === 'opening' && typeof message.url === 'string') {
			state.account = { ...state.account, url: message.url };
			render();
		}
	});
	setTimeout(() => stopListening(), 60000);
	const result = await window.picode.account.signIn();
	// Cancelled while waiting: the answer that comes back is the cancellation itself.
	if (state.accountCancelled === true) {
		return;
	}
	state.account = result?.ok === true
		? { state: 'signed-in', email: result.email, picture: result.picture, error: undefined }
		: { state: 'failed', email: undefined, error: result?.error ?? t('errorTitle') };
	render();
}

async function cancelAccountSignIn() {
	state.accountCancelled = true;
	state.account = { state: 'idle', email: undefined, error: undefined };
	render();
	try {
		await window.picode.account.cancel();
	} catch {
		// Nothing to cancel is not a failure worth a sentence.
	}
}

/**
 * Signs out: the running editor drops its session now, and the next start finishes the job. The
 * session lives in the editor's secret storage, which this window cannot reach.
 */
async function signOutOfAccount() {
	state.account = { state: 'signed-out', email: undefined, error: undefined };
	render();
	try {
		await window.picode.account.signOut();
		await command('clearPendingCode', {});
		await command('setAccountSignOut', {});
	} catch {
		// Nothing to clear is the same outcome.
	}
}

/* ------------------------------------------------------------------ *
 * Step 2: layout
 * ------------------------------------------------------------------ */

function escapeXml(text) {
	return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/**
 * A drawing of each layout, with its zones named. Plain SVG painted with the window's own tokens
 * (`.lp-*` in onboarding.css), so it follows the palette and costs nothing to load.
 */
function layoutDrawing(layout) {
	const agent = layout === 'agent';
	const [left, centre, right] = t(agent ? 'layoutAgentZones' : 'layoutEditorZones').map(escapeXml);
	const label = (x, y, text) => `<text class="lp-label" x="${x}" y="${y}" text-anchor="middle">${text}</text>`;
	const lines = (x, y, widths, gap = 9) => widths.map((width, index) => `<rect class="lp-line" x="${x}" y="${y + index * gap}" width="${width}" height="4" rx="2"/>`).join('');
	const svg = agent
		? `<rect class="lp-window" x="1" y="1" width="318" height="178" rx="10"/>
			<rect class="lp-zone" x="10" y="12" width="70" height="158" rx="6"/>
			${lines(18, 34, [50, 42, 54, 38, 46])}
			<rect class="lp-pill" x="18" y="20" width="54" height="8" rx="4"/>
			<rect class="lp-zone lp-main" x="88" y="12" width="138" height="158" rx="6"/>
			<rect class="lp-bubble" x="140" y="28" width="76" height="14" rx="7"/>
			<rect class="lp-bubble lp-bubble-pi" x="98" y="50" width="96" height="28" rx="7"/>
			<rect class="lp-bubble" x="150" y="86" width="66" height="14" rx="7"/>
			<rect class="lp-input" x="98" y="146" width="118" height="16" rx="8"/>
			<rect class="lp-zone" x="234" y="12" width="76" height="158" rx="6"/>
			<rect class="lp-pill" x="242" y="20" width="18" height="6" rx="3"/><rect class="lp-pill" x="264" y="20" width="18" height="6" rx="3"/><rect class="lp-pill" x="286" y="20" width="16" height="6" rx="3"/>
			<rect class="lp-diff-add" x="242" y="36" width="56" height="4" rx="2"/><rect class="lp-diff-del" x="242" y="45" width="40" height="4" rx="2"/><rect class="lp-diff-add" x="242" y="54" width="48" height="4" rx="2"/>
			${label(45, 120, left)}${label(157, 126, centre)}${label(272, 120, right)}`
		: `<rect class="lp-window" x="1" y="1" width="318" height="178" rx="10"/>
			<rect class="lp-zone lp-bar" x="10" y="12" width="12" height="158" rx="4"/>
			<rect class="lp-zone" x="28" y="12" width="64" height="158" rx="6"/>
			${lines(36, 22, [44, 36, 48, 30, 40, 34])}
			<rect class="lp-zone lp-main" x="98" y="12" width="138" height="110" rx="6"/>
			${lines(108, 24, [70, 96, 58, 88, 64, 40], 10)}
			<rect class="lp-zone lp-bottom" x="98" y="128" width="138" height="42" rx="6"/>
			${lines(108, 140, [60, 84], 9)}
			<rect class="lp-zone" x="242" y="12" width="68" height="158" rx="6"/>
			<rect class="lp-bubble" x="256" y="26" width="46" height="12" rx="6"/>
			<rect class="lp-bubble lp-bubble-pi" x="250" y="44" width="52" height="22" rx="6"/>
			${label(60, 120, left)}${label(167, 96, centre)}${label(167, 160, escapeXml(t('layoutEditorBottom')))}${label(276, 120, right)}`;
	return el('div', {
		class: 'layout-preview',
		'aria-hidden': 'true',
		html: `<svg viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`,
	});
}

function layoutView() {
	return [
		el('h2', { class: 'step-title', tabindex: '-1', text: t('layoutTitle') }),
		el('p', { class: 'lead', text: t('layoutLead') }),
		el('div', { class: 'layout-grid', role: 'radiogroup', 'aria-label': t('layoutTitle') }, ['agent', 'editor'].map(layoutCard)),
	];
}

function layoutCard(layout) {
	const chosen = state.layout === layout;
	const agent = layout === 'agent';
	return el('button', {
		type: 'button',
		key: layout,
		class: `layout-card${chosen ? ' chosen' : ''}`,
		role: 'radio',
		'aria-checked': chosen ? 'true' : 'false',
		onclick: () => chooseLayout(layout),
	},
		layoutDrawing(layout),
		el('div', { class: 'layout-head' },
			el('span', { class: 'layout-name', text: agent ? `🤖 ${t('layoutAgent')}` : `💻 ${t('layoutEditor')}` }),
			agent ? el('span', { class: 'badge new', text: t('layoutNew') }) : undefined,
			chosen ? el('span', { class: 'check', 'aria-hidden': 'true', text: '✓' }) : undefined,
		),
		el('span', { class: 'layout-note', text: agent ? t('layoutAgentNote') : t('layoutEditorNote') }),
		el('ul', { class: 'layout-points' }, t(agent ? 'layoutAgentPoints' : 'layoutEditorPoints').map(point => el('li', { text: point }))),
	);
}

async function chooseLayout(layout) {
	state.layout = layout;
	render();
	await withBusy('', async () => { await command('setLayout', { layout }); });
	render();
}

/* ------------------------------------------------------------------ *
 * Step 3: agent (which pi, and the model it talks to)
 * ------------------------------------------------------------------ */

/**
 * The providers that can run models: pi's own answer once it has loaded (it includes what a
 * package brings and what a subscription signed in), plus anything the profile declares that pi
 * did not list (a local router that needs no key).
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
	const seen = new Set(live.map(provider => provider.id));
	return [...live, ...declared.filter(provider => !seen.has(provider.id))];
}

function refsOf(provider) {
	return provider.models.map(model => `${provider.id}/${model}`);
}

async function loadProviders() {
	if (state.liveProviders !== undefined || state.liveProvidersLoading) {
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
		render();
	}
}

/** Asks pi which providers can be signed in to, once. */
async function loadSubscriptions() {
	if (state.subscriptions !== undefined || state.subscriptionsLoading) {
		return;
	}
	state.subscriptionsLoading = true;
	try {
		const answer = await window.picode.command('subscriptions', {});
		state.subscriptions = Array.isArray(answer?.data) ? answer.data : [];
	} catch (error) {
		state.subscriptions = [];
		state.subscriptionError = messageOf(error);
	} finally {
		state.subscriptionsLoading = false;
		render();
	}
}

/** Logos already fetched (`ok`) or given up on (`failed`); a row paints the logo only once it has arrived. */
const LOGOS = new Map();

function logoUrl(domain) {
	return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
}

/** The provider's mark: initials on a colour, the real logo once it has loaded. */
function providerMark(id) {
	const domain = PROVIDER_DOMAINS[id];
	const status = domain === undefined ? undefined : LOGOS.get(domain);
	if (status === 'ok') {
		return el('span', { class: `sub-mark logo${DARK_INK.has(domain) ? ' dark-ink' : ''}`, 'aria-hidden': 'true' }, el('img', { src: logoUrl(domain), alt: '' }));
	}
	if (domain !== undefined && status === undefined) {
		LOGOS.set(domain, 'loading');
		const image = new Image();
		image.onload = () => { LOGOS.set(domain, 'ok'); render(); };
		image.onerror = () => { LOGOS.set(domain, 'failed'); };
		image.src = logoUrl(domain);
	}
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + char.charCodeAt(0)) % 360;
	}
	return el('span', {
		class: 'sub-mark',
		'aria-hidden': 'true',
		style: `background:hsl(${hash} 55% 32%)`,
		text: id.split(/[-_]/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?',
	});
}

/** `1 model` / `2 models`, in the language on screen. */
function countOf(models) {
	return `${models} ${models === 1 ? t('modelWord') : t('modelCount')}`;
}

function agentView() {
	void loadProviders();
	void loadSubscriptions();
	return [
		el('h2', { class: 'step-title', tabindex: '-1', text: t('agentTitle') }),
		el('p', { class: 'lead', text: t('agentLead') }),
		piRow(),
		modelPanel(),
		piAdvanced(),
	];
}

/** The pi in use, on one line: the built-in one is the default and needs no decision. */
function piRow() {
	const data = snapshot();
	const external = state.piChoice === 'external';
	const version = external ? data.externalPi?.version : data.internalPiVersion;
	return el('div', { class: 'pi-row', key: 'pi-row' },
		el('img', { class: 'pi-mark', src: 'media/picode.svg', alt: '' }),
		el('span', { class: 'pi-text' },
			el('strong', { text: external ? t('piExternal') : t('piInternal') }),
			el('span', { text: external ? t('piExternalWhy') : t('piInternalWhy') }),
		),
		version ? el('span', { class: 'pill', text: `v${version}` }) : undefined,
		el('span', { class: 'pill ok', text: t('inUse') }),
	);
}

/** Choosing the machine's own pi instead: rare, so it waits behind "Advanced". */
function piAdvanced() {
	const data = snapshot();
	const external = data.externalPi;
	const option = (key, title, why, detail, available) => {
		const chosen = state.piChoice === key;
		return el('button', {
			type: 'button',
			key,
			class: `card${chosen ? ' chosen' : ''}`,
			role: 'radio',
			'aria-checked': chosen ? 'true' : 'false',
			disabled: !available,
			onclick: () => choosePi(key),
		},
			el('span', { class: 'card-head' },
				el('span', { class: 'card-title', text: title }),
				chosen ? el('span', { class: 'check', 'aria-hidden': 'true', text: '✓' }) : undefined,
			),
			el('span', { class: 'card-why', text: why }),
			detail ? el('span', { class: 'card-detail', text: detail }) : undefined,
		);
	};
	return disclosure({
		key: 'pi-advanced',
		title: t('advanced'),
		summary: state.piChoice === 'external' ? t('piExternal') : t('piInternal'),
		open: state.piAdvancedOpen,
		toggle: () => { state.piAdvancedOpen = !state.piAdvancedOpen; render(); },
		body: [
			el('p', { class: 'hint', text: t('agentAdvancedLead') }),
			el('div', { class: 'cards', role: 'radiogroup', 'aria-label': t('agentAdvancedLead') },
				option('internal', t('piInternal'), t('piInternalWhy'), data.internalPiVersion ? `${t('piInternalVersion')} ${data.internalPiVersion}` : undefined, true),
				option('external', t('piExternal'), t('piExternalWhy'),
					external ? `${t('piExternalFound')}${external.version ? ` · v${external.version}` : ''}` : t('piExternalMissing'),
					external !== undefined && external.hasProfile),
			),
		],
	});
}

async function choosePi(key) {
	state.piChoice = key;
	render();
	await withBusy('', async () => { await command('setRuntime', { runtime: key }); });
	state.liveProviders = undefined;
	render();
}

/** A section that opens in place: a header button that says what is inside, and its body. */
function disclosure({ key, title, summary, open, toggle, body }) {
	return el('div', { class: `disclosure${open ? ' open' : ''}`, key },
		el('button', { type: 'button', class: 'disclosure-head', 'aria-expanded': open ? 'true' : 'false', onclick: toggle },
			el('span', { class: 'disclosure-caret', 'aria-hidden': 'true' }),
			el('span', { class: 'disclosure-title', text: title }),
			summary ? el('span', { class: 'disclosure-summary', text: summary }) : undefined,
		),
		open ? el('div', { class: 'disclosure-body' }, body) : undefined,
	);
}

/** The model: what is in force, then one searchable list of every way to get one. */
function modelPanel() {
	const providers = providerList();
	const current = snapshot().defaultModel;
	const allRefs = providers.flatMap(refsOf);
	// A default model no provider declares is one the editor cannot run; said once pi has answered.
	const stale = hasModel() && state.liveProviders !== undefined && !allRefs.includes(current);
	const orphans = snapshot().orphanCredentials ?? [];

	const status = stale
		? el('p', { class: 'model-status warn', key: 'status' }, el('span', { class: 'dot warn' }), t('modelStale', current))
		: hasModel()
			? el('p', { class: 'model-status ok', key: 'status' }, el('span', { class: 'dot ok' }), el('span', {}, `${t('modelNewConversations')}: `, el('strong', { text: current })))
			: el('p', { class: 'model-status', key: 'status' }, el('span', { class: 'dot' }), t('modelNone'));

	const query = state.providerQuery.trim().toLowerCase();
	const matches = (...texts) => query.length === 0 || texts.some(text => typeof text === 'string' && text.toLowerCase().includes(query));

	const connected = providers
		.filter(provider => provider.models.length > 0 && matches(provider.name, provider.id))
		.map(provider => connectedRow(provider, current));
	const subscriptions = state.subscriptions === undefined
		? (query.length === 0 ? [0, 1, 2].map(index => el('div', { class: 'prow skeleton', key: `skeleton-${index}` })) : [])
		: state.subscriptions
			.filter(provider => matches(provider.name, provider.id, provider.note))
			.map(subscriptionRow);
	const keys = [...PROVIDER_PRESETS, { id: 'custom', label: t('providerCustom') }]
		.filter(preset => matches(preset.label, preset.id, preset.id === 'custom' ? t('providerCustomWhy') : undefined))
		.map(keyRow);

	const group = (key, title, rows, extra) => rows.length === 0 && extra === undefined ? undefined : el('section', { class: 'pgroup', key },
		el('h3', { class: 'pgroup-title', text: title }),
		extra,
		el('div', { class: 'prows' }, rows),
	);
	const nothing = connected.length + subscriptions.length + keys.length === 0;

	return el('div', { class: 'panel model-panel', key: 'model' },
		status,
		state.modelNote ? el('p', { class: 'model-status ok', key: 'note' }, el('span', { class: 'dot ok' }), state.modelNote) : undefined,
		orphans.length > 0 ? el('p', { class: 'hint', key: 'orphans', text: t('modelOrphanKey', orphans.join(', ')) }) : undefined,
		el('label', { class: 'search', key: 'search' },
			el('span', { class: 'search-mark', 'aria-hidden': 'true', text: '🔎' }),
			el('input', {
				type: 'search',
				value: state.providerQuery,
				placeholder: t('providerSearch'),
				'aria-label': t('providerSearch'),
				spellcheck: 'false',
				oninput: event => { state.providerQuery = event.target.value; render(); },
			}),
		),
		nothing ? el('p', { class: 'hint', key: 'none', text: t('providerNoMatch', state.providerQuery.trim()) }) : undefined,
		group('g-connected', t('groupConnected'), connected),
		group('g-subscriptions', t('groupSubscriptions'), subscriptions,
			state.subscriptionsLoading && state.subscriptions === undefined ? el('p', { class: 'hint', text: t('subLoading') })
				: state.subscriptionError ? el('p', { class: 'hint error', text: state.subscriptionError })
					: state.subscriptions?.length === 0 && query.length === 0 ? el('p', { class: 'hint', text: t('subNone') }) : undefined),
		group('g-keys', t('groupKeys'), keys),
	);
}

/** One provider row: a header that opens it, and what it holds when open. */
function providerRow({ key, mark, name, note, chip, chipOk, open, onclick, disabled, body }) {
	return el('div', { class: `prow${open ? ' open' : ''}`, key },
		el('button', { type: 'button', class: 'prow-head', 'aria-expanded': open ? 'true' : 'false', disabled, onclick },
			mark,
			el('span', { class: 'prow-text' },
				el('span', { class: 'prow-name', text: name }),
				note ? el('span', { class: 'prow-note', text: note }) : undefined,
			),
			chip ? el('span', { class: `pill${chipOk ? ' ok' : ''}`, text: chip }) : undefined,
			el('span', { class: 'prow-caret', 'aria-hidden': 'true' }),
		),
		open && body ? el('div', { class: 'prow-body' }, body) : undefined,
	);
}

function toggleProvider(key, onOpen) {
	const opening = state.openProvider !== key;
	state.openProvider = opening ? key : undefined;
	state.modelNote = undefined;
	if (opening) {
		onOpen?.();
	}
	render();
}

/** A provider pi can run now: open it to pick the model new conversations use. */
function connectedRow(provider, current) {
	const key = `live:${provider.id}`;
	const refs = refsOf(provider).toSorted((left, right) => left.localeCompare(right));
	const holdsCurrent = refs.includes(current);
	const note = `${countOf(refs.length)}${provider.subscription ? ` · ${t('subSignedIn')}` : provider.hasKey === false ? ` · ${t('modelNoKey')}` : ''}`;
	const open = state.openProvider === key;
	const picked = refs.includes(state.pickedModel[provider.id]) ? state.pickedModel[provider.id] : holdsCurrent ? current : refs[0];
	return providerRow({
		key,
		mark: providerMark(provider.id),
		name: provider.name,
		note,
		chip: holdsCurrent ? t('inUse') : undefined,
		chipOk: true,
		open,
		onclick: () => toggleProvider(key),
		body: open ? [
			el('label', { class: 'field' },
				el('span', { class: 'field-label', text: t('modelNewConversations') }),
				el('select', {
					value: picked,
					onchange: event => { state.pickedModel[provider.id] = event.target.value; render(); },
				}, refs.map(ref => el('option', { value: ref, text: ref }))),
			),
			el('p', { class: 'hint', text: t('modelAgentsNote') }),
			el('div', { class: 'panel-actions' },
				el('button', {
					type: 'button',
					class: 'primary',
					disabled: picked === undefined || picked === current,
					onclick: () => useModel(picked),
				}, picked === current ? t('inUse') : t('modelSaveDefault')),
			),
		] : undefined,
	});
}

async function useModel(ref) {
	await withBusy('', async () => { await command('setModel', { ref }); });
	state.modelNote = undefined;
	render();
}

/** An account pi can sign in to; clicking starts the sign-in, and the row carries it. */
function subscriptionRow(provider) {
	const key = `sub:${provider.id}`;
	const running = state.signIn !== undefined && state.signIn.providerId === provider.id ? state.signIn : undefined;
	const busyElsewhere = state.signIn !== undefined && state.signIn.running === true && running === undefined;
	return providerRow({
		key,
		mark: providerMark(provider.id),
		name: provider.name,
		note: provider.note ?? t('subYourAccount'),
		chip: provider.signedIn === true ? `✓ ${t('subSignedIn')}` : t('subSignIn'),
		chipOk: provider.signedIn === true,
		open: running !== undefined,
		disabled: busyElsewhere || running?.running === true,
		onclick: () => startSignIn(provider.id),
		body: running === undefined ? undefined : signInBody(provider, running),
	});
}

/** A network failure, said for a person rather than as `fetch failed`. */
function signInFailure(message) {
	return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR|socket hang up|network/i.test(message ?? '')
		? t('subNetwork')
		: (message ?? '');
}

/** The row being signed in: where it stands, and the one thing that can be done next. */
function signInBody(provider, running) {
	const failed = running.running !== true && running.finished !== true && running.error !== undefined;
	const phase = running.finished === true ? 'done' : failed ? 'failed' : running.code !== undefined ? 'code' : 'browser';
	const note = phase === 'done' ? t('subDone')
		: phase === 'failed' ? t('subFailed')
			: phase === 'code' ? t('subEnterCode')
				: running.url === undefined ? t('subStarting') : t('subWaiting');

	const prompt = running.prompt;
	// pi's "or paste the code here" waits behind the browser: shown only if it has not come back.
	const pasteReady = prompt?.type === 'manual_code' && running.pasteReady === true;
	const showPrompt = prompt !== undefined && (prompt.type !== 'manual_code' || pasteReady);

	const actions = [];
	if (phase === 'browser' || phase === 'code') {
		if (running.url !== undefined) {
			actions.push(el('button', { type: 'button', class: 'secondary', onclick: () => window.picode.openExternal(running.url) }, t('subOpenAgain')));
		}
		actions.push(el('button', { type: 'button', class: 'secondary', onclick: () => window.picode.signIn.cancel() }, t('subCancel')));
	} else if (phase === 'failed') {
		actions.push(
			el('button', { type: 'button', class: 'primary', onclick: () => startSignIn(provider.id) }, t('subRetry')),
			el('button', { type: 'button', class: 'secondary', onclick: () => { state.signIn = undefined; render(); } }, t('subClose')),
		);
	}

	return el('div', { class: `sub-card phase-${phase}` },
		el('p', { class: 'sub-state' },
			phase === 'done' ? el('span', { class: 'sub-check', text: '✓' })
				: phase === 'failed' ? el('span', { class: 'sub-cross', text: '!' })
					: el('span', { class: 'spinner' }),
			note,
		),
		phase === 'browser' && running.url !== undefined ? el('p', { class: 'hint', text: t('subBrowserHint') }) : undefined,
		phase === 'code' ? [
			el('button', {
				type: 'button',
				class: `sub-code${running.copied ? ' copied' : ''}`,
				title: t('subCopyCode'),
				onclick: () => {
					void navigator.clipboard.writeText(running.code);
					state.signIn = { ...state.signIn, copied: true };
					render();
				},
			}, el('span', { text: running.code }), el('span', { class: 'sub-copy', text: '⧉' })),
			el('p', { class: 'hint', text: t('subCodeHint') }),
		] : undefined,
		showPrompt ? (prompt.type === 'manual_code'
			? el('div', { class: 'sub-paste' }, el('p', { class: 'hint', text: t('subPasteHint') }), promptField(prompt))
			: promptField(prompt)) : undefined,
		phase === 'failed' ? el('p', { class: 'hint error', text: signInFailure(running.error) }) : undefined,
		actions.length > 0 ? el('div', { class: 'panel-actions' }, actions) : undefined,
	);
}

/** One of pi's questions, as a field the page can answer. */
function promptField(prompt) {
	const send = value => {
		void window.picode.signIn.answer(prompt.id, value);
		// Answered: the question leaves the row, so only what pi says next is left to wait on.
		if (state.signIn?.prompt?.id === prompt.id) {
			state.signIn = { ...state.signIn, prompt: undefined };
			render();
		}
	};
	if (prompt.type === 'select') {
		return el('label', { class: 'field', key: `prompt-${prompt.id}` },
			el('span', { class: 'field-label', text: prompt.message }),
			// A blank first entry keeps every real option one choice away from sending: a select that
			// already shows its first option never fires `change` when that same option is picked.
			el('select', { value: '', onchange: event => { if (event.target.value !== '') { send(event.target.value); } } },
				el('option', { value: '', text: t('subChoose'), disabled: true }),
				(prompt.options ?? []).map(option => el('option', { value: option.id, text: option.label }))),
		);
	}
	return el('div', { class: 'field', key: `prompt-${prompt.id}` },
		el('span', { class: 'field-label', text: prompt.message }),
		el('div', { class: 'inline' },
			el('input', {
				type: prompt.type === 'secret' ? 'password' : 'text',
				placeholder: prompt.placeholder ?? '',
				onkeydown: event => { if (event.key === 'Enter') { send(event.target.value); } },
			}),
			el('button', { type: 'button', class: 'secondary', onclick: event => send(event.target.closest('.inline').querySelector('input').value) }, t('next')),
		),
	);
}

/** Starts pi's own sign-in and follows it, event by event. */
async function startSignIn(providerId) {
	clearTimeout(state.pasteTimer);
	state.signIn = { running: true, providerId };
	state.openProvider = `sub:${providerId}`;
	state.subscriptionError = undefined;
	render();
	let run;
	const unsubscribe = window.picode.signIn.onEvent(message => {
		// Events from an attempt that is no longer the one on screen are not ours to act on.
		if (run !== undefined && message.run !== undefined && message.run !== run) {
			return;
		}
		const current = state.signIn ?? { running: true, providerId };
		if (message.type === 'event') {
			const event = message.event ?? {};
			// pi's own wording is its plumbing: the row says where things stand in the setup's words.
			if (event.type === 'auth_url') {
				state.signIn = { ...current, url: event.url };
				void window.picode.openExternal(event.url);
			} else if (event.type === 'device_code') {
				state.signIn = { ...current, code: event.userCode, url: event.verificationUri };
				void navigator.clipboard.writeText(event.userCode).catch(() => undefined);
				void window.picode.openExternal(event.verificationUri);
			} else {
				return;
			}
			render();
			return;
		}
		if (message.type === 'prompt') {
			// "How do you want to sign in?" has an answer already: the browser one, which pi marks as
			// its default. It is sent straight away and the question never reaches the screen.
			const options = message.prompt?.options ?? [];
			const preferred = message.prompt?.type === 'select'
				? (options.find(option => /\(default\)/i.test(option.label ?? '')) ?? options.find(option => /browser/i.test(option.label ?? '')))
				: undefined;
			if (preferred !== undefined) {
				void window.picode.signIn.answer(message.id, preferred.id);
				return;
			}
			state.signIn = { ...current, prompt: { id: message.id, ...message.prompt }, pasteReady: false };
			if (message.prompt?.type === 'manual_code') {
				clearTimeout(state.pasteTimer);
				state.pasteTimer = setTimeout(() => {
					if (state.signIn?.prompt?.id === message.id) {
						state.signIn = { ...state.signIn, pasteReady: true };
						render();
					}
				}, PASTE_FALLBACK_MS);
			}
			render();
			return;
		}
		if (message.type === 'promptGone') {
			if (current.prompt?.id === message.id) {
				state.signIn = { ...current, prompt: undefined, pasteReady: false };
				render();
			}
			return;
		}
		if (message.type === 'done') {
			clearTimeout(state.pasteTimer);
			state.signIn = { ...current, running: false, finished: true, prompt: undefined };
			// The tick shows for a moment, then the row goes back to saying it is signed in.
			setTimeout(() => {
				if (state.signIn?.finished === true && state.signIn.providerId === current.providerId) {
					state.signIn = undefined;
					render();
				}
			}, 1800);
			unsubscribe();
			void refreshAfterSignIn();
			render();
			return;
		}
		if (message.type === 'cancelled' || message.type === 'exit') {
			// `exit` is the safety net: whatever ended the child, the row must stop saying it waits.
			clearTimeout(state.pasteTimer);
			state.signIn = undefined;
			unsubscribe();
			render();
			return;
		}
		if (message.type === 'error') {
			clearTimeout(state.pasteTimer);
			state.signIn = { ...current, running: false, prompt: undefined, error: message.message ?? '' };
			unsubscribe();
			render();
		}
	});
	const started = await window.picode.signIn.start(providerId);
	run = started?.run;
}

/** After a sign-in the profile has new models: ask again. */
async function refreshAfterSignIn() {
	state.liveProviders = undefined;
	state.subscriptions = undefined;
	await withBusy('', async () => {
		const answer = await window.picode.command('state', {});
		if (answer?.data) {
			adopt(answer.data);
		}
	});
	render();
}

/** A provider reached with a key: a preset fills the address, or any address for `custom`. */
function keyRow(preset) {
	const key = `key:${preset.id}`;
	const open = state.openProvider === key;
	const custom = preset.id === 'custom';
	return providerRow({
		key,
		mark: custom ? el('span', { class: 'sub-mark plain', 'aria-hidden': 'true', text: '🔗' }) : providerMark(preset.id),
		name: preset.label,
		note: custom ? t('providerCustomWhy') : t('providerKeyNote'),
		open,
		onclick: () => toggleProvider(key, () => {
			// A known provider fills its own address and dialect: asking for them is asking the owner
			// to type what the preset already knows.
			state.provider = { id: custom ? '' : preset.id, endpoint: custom ? '' : preset.endpoint, api: custom ? 'openai-completions' : preset.api, key: '' };
			state.providerAdvanced = custom;
			state.probe = undefined;
			state.providerError = undefined;
		}),
		body: open ? keyForm(preset) : undefined,
	});
}

function keyForm(preset) {
	const custom = preset.id === 'custom';
	const field = (key, label, input) => el('label', { class: 'field', key }, el('span', { class: 'field-label', text: label }), input);
	const text = (name, value) => el('input', {
		type: 'text', value, spellcheck: 'false',
		oninput: event => { state.provider[name] = event.target.value; },
	});
	return [
		field('f-key', t('providerKey'), el('input', {
			type: 'password', value: state.provider.key, spellcheck: 'false', autocomplete: 'off', placeholder: 'sk-…',
			oninput: event => { state.provider.key = event.target.value; },
			onkeydown: event => { if (event.key === 'Enter') { void connectProvider(); } },
		})),
		el('p', { class: 'hint', key: 'f-key-hint', text: t('providerKeyHint') }),
		state.providerAdvanced ? el('div', { class: 'fields', key: 'f-advanced' },
			field('f-name', t('providerName'), text('id', state.provider.id)),
			field('f-endpoint', t('providerEndpoint'), text('endpoint', state.provider.endpoint)),
			field('f-api', t('providerDialect'), el('select', {
				value: state.provider.api,
				onchange: event => { state.provider.api = event.target.value; },
			}, PROVIDER_APIS.map(api => el('option', { value: api, text: api })))),
		) : undefined,
		el('div', { class: 'form-links', key: 'f-links' },
			custom ? undefined : el('button', {
				type: 'button', class: 'link small',
				onclick: () => { state.providerAdvanced = !state.providerAdvanced; render(); },
			}, state.providerAdvanced ? t('providerAdvancedHide') : t('providerAdvancedShow')),
			custom ? undefined : el('button', {
				type: 'button', class: 'link small',
				onclick: async () => {
					const answer = await window.picode.openExternal(preset.keyUrl);
					if (answer?.ok !== true) {
						setNotice(answer?.error ?? t('errorTitle'), 'error');
					}
				},
			}, `${t('providerGetKey')} · ${preset.label} ↗`),
		),
		probeLine(),
		state.providerError ? el('p', { class: 'hint error', key: 'f-error', text: state.providerError }) : undefined,
		el('div', { class: 'panel-actions', key: 'f-actions' },
			el('span', { class: 'hint', text: t('providerWait') }),
			el('button', { type: 'button', class: 'secondary', disabled: state.probeRunning, onclick: () => testProvider() }, t('providerTest')),
			el('button', { type: 'button', class: 'primary', disabled: state.connecting, onclick: () => connectProvider() },
				state.connecting ? t('providerConnecting') : t('providerConnect')),
		),
	];
}

function probeLine() {
	if (state.probeRunning) {
		return el('p', { class: 'probe', key: 'f-probe' }, el('span', { class: 'spinner' }), t('providerTesting'));
	}
	if (state.probe === undefined) {
		return undefined;
	}
	return state.probe.ok
		? el('p', { class: 'probe ok', key: 'f-probe' }, el('span', { class: 'dot ok' }), t('providerProbeOk', state.probe.models?.length ?? 0, state.probe.latencyMs ?? 0))
		: el('p', { class: 'probe bad', key: 'f-probe' }, el('span', { class: 'dot bad' }), state.probe.error ?? t('providerFail'));
}

/** Asks the address what it has, with the key. Nothing is saved. */
async function testProvider() {
	state.probeRunning = true;
	state.probe = undefined;
	state.providerError = undefined;
	render();
	try {
		const answer = await command('testProvider', { endpoint: state.provider.endpoint.trim(), key: state.provider.key.trim() });
		state.probe = answer.data;
	} catch (error) {
		state.probe = { ok: false, error: messageOf(error) };
	} finally {
		state.probeRunning = false;
		render();
	}
}

/** Saves the provider: the backend asks the address first and refuses one that lists no models. */
async function connectProvider() {
	if (state.connecting) {
		return;
	}
	const request = {
		id: state.provider.id.trim(),
		endpoint: state.provider.endpoint.trim(),
		api: state.provider.api,
		key: state.provider.key.trim(),
		makeDefault: !hasModel(),
	};
	state.connecting = true;
	state.providerError = undefined;
	render();
	let connected = false;
	try {
		const answer = await command('addProvider', { request });
		const models = answer.data?.models?.length ?? 0;
		state.provider = { ...state.provider, key: '' };
		state.probe = undefined;
		state.liveProviders = undefined;
		state.openProvider = `live:${request.id}`;
		state.providerQuery = '';
		const label = PROVIDER_PRESETS.find(preset => preset.id === request.id && preset.endpoint === request.endpoint)?.label ?? request.id;
		state.modelNote = t('providerConnectedDone', label, models);
		connected = true;
	} catch (error) {
		state.providerError = messageOf(error);
	} finally {
		state.connecting = false;
		render();
	}
	if (connected) {
		// The new provider's row opened somewhere else in the list: bring it to where the eyes are.
		requestAnimationFrame(() => document.querySelector('.prow.open')?.scrollIntoView({ block: 'nearest' }));
	}
}

/* ------------------------------------------------------------------ *
 * Step 4: look
 * ------------------------------------------------------------------ */

function themeById(id) {
	return THEMES.find(theme => theme.id === id);
}

function lookView() {
	const shown = THEMES.filter(theme => state.showAllThemes || theme.featured || theme.id === state.theme);
	const previewed = themeById(state.previewTheme) ?? themeById(state.theme) ?? themeById(DEFAULT_THEME);
	return [
		el('h2', { class: 'step-title', tabindex: '-1', text: t('themeTitle') }),
		el('p', { class: 'lead', text: t('lookLead') }),
		el('div', { class: 'look', key: 'look' },
			el('div', { class: 'look-list' },
				el('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': t('themeTitle') }, shown.map(themeCard)),
				el('button', {
					type: 'button', class: 'link small',
					onclick: () => { state.showAllThemes = !state.showAllThemes; render(); },
				}, state.showAllThemes ? t('themeFewer') : t('themeAllCount', THEMES.length)),
			),
			themePreview(previewed),
		),
	];
}

function themeCard(theme) {
	const chosen = state.theme === theme.id;
	const p = theme.palette;
	const show = () => { if (state.previewTheme !== theme.id) { state.previewTheme = theme.id; render(); } };
	const hide = () => { if (state.previewTheme === theme.id) { state.previewTheme = undefined; render(); } };
	return el('button', {
		type: 'button',
		key: theme.id,
		class: `theme-card${chosen ? ' chosen' : ''}`,
		role: 'radio',
		'aria-checked': chosen ? 'true' : 'false',
		onmouseenter: show,
		onfocus: show,
		onmouseleave: hide,
		onblur: hide,
		onclick: () => chooseTheme(theme),
	},
		el('span', { class: 'theme-swatch', 'aria-hidden': 'true', style: `background:${p.bg};border-color:${p.line}` },
			[p.keyword, p.string, p.accent].map(colour => el('i', { style: `background:${colour}` })),
		),
		el('span', { class: 'theme-name', text: theme.label }),
		chosen ? el('span', { class: 'check', 'aria-hidden': 'true', text: '✓' }) : undefined,
	);
}

/** Dark or light text, whichever reads on a colour (`#rrggbb`). */
function inkOn(hex) {
	const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#0B0F19' : '#FFFFFF';
}

/** A small editor and chat in the theme's own colours: what the grid's names cannot say. */
function themePreview(theme) {
	const p = theme.palette;
	const chosen = theme.id === state.theme;
	const span = (colour, text) => `<span style="color:${colour}">${escapeXml(text)}</span>`;
	const code = [
		span(p.comment, '// the agent wrote this'),
		`${span(p.keyword, 'export function')} ${span(p.fg, 'greet')}${span(p.comment, '(name) {')}`,
		`  ${span(p.keyword, 'return')} ${span(p.string, '`Hello, ${name}`')}`,
		span(p.comment, '}'),
	].join('<br>');
	const fileRow = (name, active) => el('span', {
		class: `tp-file${active ? ' active' : ''}`,
		style: active ? `color:${p.fg};background:color-mix(in srgb, ${p.accent} 22%, transparent)` : `color:${p.comment}`,
		text: name,
	});
	return el('aside', { class: 'theme-preview-pane', 'aria-label': t('previewLabel') },
		el('div', { class: 'tp', style: `background:${p.bg};color:${p.fg};border-color:${p.line}` },
			el('div', { class: 'tp-bar', style: `background:${p.panel};border-color:${p.line}` },
				el('i', {}), el('i', {}), el('i', {}),
				el('span', { class: 'tp-tab', style: `color:${p.fg};border-color:${p.accent}`, text: 'greet.ts' }),
			),
			el('div', { class: 'tp-body' },
				el('div', { class: 'tp-side', style: `background:${p.panel};border-color:${p.line}` },
					fileRow('src', false), fileRow('greet.ts', true), fileRow('app.ts', false), fileRow('README.md', false),
				),
				el('div', { class: 'tp-code', html: code }),
			),
			el('div', { class: 'tp-chat', style: `background:${p.panel};border-color:${p.line}` },
				el('span', { class: 'tp-msg you', style: `background:${p.accent};color:${inkOn(p.accent)}`, text: t('previewAsk') }),
				el('span', { class: 'tp-msg', style: `background:color-mix(in srgb, ${p.fg} 9%, transparent);color:${p.fg}`, text: t('previewAnswer') }),
			),
		),
		el('p', { class: 'tp-caption' },
			el('strong', { text: theme.label }),
			chosen ? el('span', { class: 'pill ok', text: t('inUse') }) : el('span', { class: 'hint', text: t('themeClickToUse') }),
		),
	);
}

async function chooseTheme(theme) {
	state.theme = theme.id;
	render();
	await withBusy('', async () => { await command('setTheme', { id: theme.id }); });
	render();
}

/* ------------------------------------------------------------------ *
 * Step 5: ready
 * ------------------------------------------------------------------ */

function doneView() {
	return [
		el('h2', { class: 'step-title', tabindex: '-1', text: t('doneTitle') }),
		el('p', { class: 'lead', text: t('doneLead') }),
		summary(),
		startPanel(),
		advancedBlock(),
		el('p', { class: 'pro', text: t('proNote') }),
	];
}

/** What the editor starts with, each line with a way back to the step that decides it. */
function summary() {
	const data = snapshot();
	const external = data.runtime === 'external';
	const piValue = external
		? `${t('piExternal')}${data.externalPi?.version ? ` · ${data.externalPi.version}` : ''}`
		: `${t('piInternal')}${data.internalPiVersion ? ` · ${data.internalPiVersion}` : ''}`;
	const rows = [
		data.accountAvailable === true ? { key: 'account', mark: '👤', label: t('accountFact'), value: state.account.state === 'signed-in' ? (state.account.email ?? t('accountSignedInShort')) : t('accountNone'), step: 'welcome' } : undefined,
		{ key: 'layout', mark: '🧭', label: t('layoutFact'), value: state.layout === 'agent' ? t('layoutAgent') : t('layoutEditor'), step: 'layout' },
		{ key: 'pi', mark: '🤖', label: t('welcomeFactsPi'), value: piValue, step: 'agent' },
		{ key: 'model', mark: '🧠', label: t('welcomeFactsModel'), value: hasModel() ? data.defaultModel : t('modelNothingYet'), step: 'agent', attention: !hasModel() },
		{ key: 'theme', mark: '🎨', label: t('welcomeFactsTheme'), value: themeById(state.theme)?.label ?? state.theme ?? t('notSet'), step: 'look' },
		languageRow(),
	].filter(Boolean);
	return el('div', { class: 'summary', key: 'summary' }, rows.map(row => el('div', { class: `summary-row${row.attention ? ' attention' : ''}`, key: row.key },
		el('span', { class: 'summary-mark', 'aria-hidden': 'true', text: row.mark }),
		el('span', { class: 'summary-label', text: row.label }),
		el('span', { class: 'summary-value', text: row.value }),
		row.step === undefined ? undefined : el('button', {
			type: 'button', class: 'link small',
			'aria-label': `${t('summaryChange')}: ${row.label}`,
			onclick: () => go(STEPS.indexOf(row.step)),
		}, t('summaryChange')),
	)));
}

/** The summary's language row: only while the editor still has to change, or could not get its pack. */
function languageRow() {
	const name = STRINGS[language]?.language ?? language;
	if (state.languageOutcome === 'ready') {
		return { key: 'language', mark: '🌐', label: t('languageFact'), value: `${name} · ${t('languageReady')}` };
	}
	if (state.languageOutcome === 'offline') {
		return { key: 'language', mark: '🌐', label: t('languageFact'), value: `${name} · ${t('languageOffline')}` };
	}
	return undefined;
}

/** One question, three answers. */
function startPanel() {
	const starts = [
		{ kind: 'folder', title: t('startFolder'), why: t('startFolderWhy'), mark: '📂' },
		{ kind: 'clone', title: t('startClone'), why: t('startCloneWhy'), mark: '🐙' },
		{ kind: 'blank', title: t('startBlank'), why: t('startBlankWhy'), mark: '⚡' },
	];
	const cloning = state.startKind === 'clone';
	return el('div', { class: 'panel', key: 'start' },
		el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: t('startTitle') })),
		el('div', { class: 'cards start-cards', role: 'radiogroup', 'aria-label': t('startTitle') }, starts.map(start => {
			const chosen = state.startKind === start.kind;
			return el('button', {
				type: 'button',
				key: start.kind,
				class: `card start-card${chosen ? ' chosen' : ''}`,
				role: 'radio',
				'aria-checked': chosen ? 'true' : 'false',
				onclick: () => chooseStart(start.kind),
			},
				el('span', { class: 'card-head' },
					el('span', { class: 'start-mark', 'aria-hidden': 'true', text: start.mark }),
					el('span', { class: 'card-title', text: start.title }),
				),
				el('span', { class: 'card-why', text: start.why }),
			);
		})),
		cloning ? el('div', { class: 'inline', key: 'clone' },
			el('input', {
				type: 'text', spellcheck: 'false', placeholder: 'https://github.com/user/repo',
				value: state.cloneUrl, 'aria-label': t('startClone'),
				oninput: event => { state.cloneUrl = event.target.value; },
				onkeydown: event => { if (event.key === 'Enter') { void cloneRepository(); } },
			}),
			el('button', { type: 'button', class: 'secondary', onclick: () => cloneRepository() }, t('clone')),
		) : undefined,
		el('p', { class: 'hint', key: 'start-hint', text: state.folder !== undefined ? `${t('folderChosen')} ${state.folder}` : cloning ? '' : t('startHint') }),
	);
}

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
	render();
}

async function cloneRepository() {
	const url = state.cloneUrl.trim();
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
	render();
}

/** Gentle's two preferences, read once from the profile the editor will use. */
async function loadGentle() {
	if (state.gentle !== undefined || state.gentleLoading) {
		return;
	}
	state.gentleLoading = true;
	try {
		const answer = await window.picode.command('gentle', {});
		if (answer?.data) {
			state.gentle = answer.data;
		}
	} catch {
		// The section simply does not show: the preferences stay what Gentle has on disk.
	} finally {
		state.gentleLoading = false;
		render();
	}
}

const CONTEXT_MODES = () => [
	{ value: 'project', title: t('contextProject'), why: t('contextProjectWhy'), mark: '📂', badge: t('contextRecommended') },
	{ value: 'file', title: t('contextFile'), why: t('contextFileWhy'), mark: '📄' },
	{ value: 'selection', title: t('contextSelection'), why: t('contextSelectionWhy'), mark: '🔒' },
];
const PERSONAS = () => [
	{ value: 'gentleman', title: t('personaGentleman'), why: t('personaGentlemanWhy'), mark: '🎩' },
	{ value: 'neutral', title: t('personaNeutral'), why: t('personaNeutralWhy'), mark: '🧭' },
];
const PERMISSIONS = () => [
	{ value: 'normal', title: t('permissionsNormal'), why: t('permissionsNormalWhy'), mark: '🛡️' },
	{ value: 'auto', title: t('permissionsAuto'), why: t('permissionsAutoWhy'), mark: '⚙️' },
	{ value: 'yolo', title: t('permissionsYolo'), why: t('permissionsYoloWhy'), mark: '🚀' },
];

/**
 * Everything a first run does not have to decide, in one place that starts closed. Its header says
 * what is in force, so nobody has to open it to know.
 */
function advancedBlock() {
	void loadGentle();
	const titleOf = (list, value) => list.find(option => option.value === value)?.title;
	const parts = [
		`${t('extraMcp')}: ${state.extras.mcp ? t('on') : t('off')}`,
		state.extras.context === false ? `${t('contextTitle')}: ${t('off')}` : titleOf(CONTEXT_MODES(), state.contextMode),
		state.gentle ? titleOf(PERSONAS(), state.gentle.persona) : undefined,
		state.gentle ? titleOf(PERMISSIONS(), state.gentle.permissions) : undefined,
	].filter(Boolean);
	return disclosure({
		key: 'advanced',
		title: `⚙️ ${t('advanced')}`,
		summary: parts.join(' · '),
		open: state.advancedOpen,
		toggle: () => { state.advancedOpen = !state.advancedOpen; render(); },
		body: [
			el('p', { class: 'hint', text: t('advancedLead') }),
			toggleRow('mcp', t('extraMcp'), t('extraMcpWhy')),
			state.voiceAvailable ? toggleRow('voice', t('extraVoice'), t('extraVoiceWhy')) : undefined,
			choiceGroup('context', t('contextTitle'), t('contextLead'), state.extras.context === false ? undefined : state.contextMode, CONTEXT_MODES(), value => chooseContextMode(value),
				state.extras.context === false ? t('contextOffNote') : undefined),
			state.gentle === undefined ? undefined : [
				choiceGroup('persona', t('gentlePersonaTitle'), t('gentleLead'), state.gentle.persona, PERSONAS(), value => chooseGentle('persona', value)),
				choiceGroup('permissions', t('gentlePermissionsTitle'), undefined, state.gentle.permissions, PERMISSIONS(), value => chooseGentle('permissions', value)),
			],
		],
	});
}

function toggleRow(key, title, why) {
	return el('label', { class: 'switch', key: `switch-${key}` },
		el('span', { class: 'switch-text' },
			el('strong', { text: title }),
			el('span', { class: 'switch-why', text: why }),
		),
		el('input', {
			type: 'checkbox',
			role: 'switch',
			checked: state.extras[key] === true,
			onchange: async event => {
				state.extras[key] = event.target.checked;
				render();
				await withBusy('', async () => { await command('setExtras', { values: { [key]: state.extras[key] } }); });
			},
		}),
	);
}

/** One preference as a row of cards, radio semantics. */
function choiceGroup(key, title, lead, current, options, choose, note) {
	return el('div', { class: 'choice', key: `choice-${key}` },
		el('div', { class: 'choice-title', text: title }),
		lead ? el('p', { class: 'hint', text: lead }) : undefined,
		el('div', { class: 'modes', role: 'radiogroup', 'aria-label': title }, options.map(option => {
			const chosen = current === option.value;
			return el('button', {
				type: 'button',
				key: option.value,
				class: `mode${chosen ? ' chosen' : ''}`,
				role: 'radio',
				'aria-checked': chosen ? 'true' : 'false',
				onclick: () => choose(option.value),
			},
				el('span', { class: 'mode-head' },
					el('span', { class: 'mode-mark', 'aria-hidden': 'true', text: option.mark }),
					el('strong', { text: option.title }),
					option.badge ? el('span', { class: 'pill ok', text: option.badge }) : undefined,
				),
				el('span', { class: 'mode-why', text: option.why }),
			);
		})),
		note ? el('p', { class: 'hint', text: note }) : undefined,
	);
}

/**
 * Picks how much context travels, and makes sure the context is **on**: the product keeps two
 * settings (whether, and how much) and this step shows only the second, so a card must never look
 * chosen while nothing is attached.
 */
async function chooseContextMode(mode) {
	const wasOff = state.extras.context !== true;
	state.contextMode = mode;
	state.extras.context = true;
	render();
	await withBusy('', async () => {
		await command('setContextMode', { mode });
		if (wasOff) {
			await command('setExtras', { values: { context: true } });
		}
	});
}

async function chooseGentle(key, value) {
	state.gentle = { ...state.gentle, [key]: value };
	render();
	await withBusy('', async () => {
		const answer = await command('setGentle', { key, value });
		if (answer?.data) {
			state.gentle = answer.data;
		}
	});
	render();
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function go(index) {
	if (index < 0 || index >= STEPS.length) {
		return;
	}
	state.step = index;
	state.visited.add(index);
	state.previewTheme = undefined;
	// An alert belongs to the screen that raised it.
	setNotice(undefined);
	render();
}

/** Records the setup and lets the editor open. */
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
// Skip has one meaning everywhere: open the editor now, with whatever is already chosen.
$('skip').addEventListener('click', () => void finish(true));
$('notice-close').addEventListener('click', () => setNotice(undefined));

/*
 * Escape closes the thing on top — the Import view, a notice — and nothing else. It used to skip the
 * whole setup, which is the last thing a key pressed to dismiss a menu should do.
 */
document.addEventListener('keydown', event => {
	if (event.key !== 'Escape' || event.defaultPrevented) {
		return;
	}
	if (!$('import-view').hidden && importView.embedded) {
		closeImportView();
		event.preventDefault();
	} else if (state.notice !== undefined) {
		setNotice(undefined);
		event.preventDefault();
	}
});

/* ------------------------------------------------------------------ *
 * Language
 * ------------------------------------------------------------------ */

function setLanguage(next) {
	language = next;
	paintLanguage();
	document.documentElement.lang = next;
	$('language').setAttribute('aria-label', t('languageFact'));
	render();
}

/** The country's flag for a language, as a small vector image: emoji flags are only letters on Windows. */
function flagOf(code) {
	return el('span', { class: 'flag', 'aria-hidden': 'true', html: window.PICODE_FLAGS?.[code] ?? '' });
}

function paintLanguage() {
	fill($('language'),
		flagOf(language),
		el('span', { class: 'lang-name', text: STRINGS[language]?.language ?? language }),
		el('span', { class: 'lang-caret', 'aria-hidden': 'true', text: '▾' }),
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
 * the steps go by, and the editor installs it at its first start. Silent when it cannot.
 */
async function prepareLanguage(code) {
	state.languageOutcome = undefined;
	try {
		const answer = await command('prepareLanguage', { language: code, label: STRINGS[code]?.language ?? code, firstRun: state.mode === 'first-run' });
		if (code === language) {
			state.languageOutcome = answer.data?.language;
			render();
		}
	} catch {
		// Nothing to say: the editor still opens.
	}
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function main() {
	fillLanguages();
	setLanguage(initialLanguage());

	// The setup follows the editor's shared session: a sign-in or a sign-out there shows here at once.
	window.picode.account.onState(message => {
		const email = typeof message?.email === 'string' ? message.email : '';
		// Ignore the echo of our own state while waiting: repainting would drop the spinner mid-flow.
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
			? { state: 'signed-in', email, picture, error: undefined }
			: { state: 'idle', email: undefined, error: undefined };
		render();
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
				// Nothing chosen yet: PiCode Dark is the product default, so record it now, which keeps
				// the editor on the brand palette instead of an unset setting.
				await command('setTheme', { id: DEFAULT_THEME }).catch(() => undefined);
			}
			if (state.mode === 'first-run' && boot.snapshot.layout !== 'agent') {
				// A first setup recommends the new layout: recorded now, so skipping keeps it. The
				// other modes keep whatever the person has.
				await command('setLayout', { layout: 'agent' }).catch(() => undefined);
			}
			state.piChoice = boot.snapshot.runtime === 'external' ? 'external' : 'internal';
			state.piAdvancedOpen = state.piChoice === 'external';
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
		setNotice(`${t('errorTitle')}: ${messageOf(error)}`, 'error');
	}

	go(0);
	void prepareLanguage(language);
	// Opened by the editor's Import command: that view is the whole window.
	if (state.mode === 'import') {
		void openImportView({ embedded: false });
	}
}

main();
