/*
 * The Import view: bring things from another pi or from VS Code, one item at a time.
 *
 * It is a layer of the setup window, not a window of its own. In the first-run wizard it opens
 * over the steps and "Done" goes back to them; when the editor opens the window just for this
 * (`import` mode) it is the only thing on screen and "Done" closes the window.
 *
 * Everything it knows comes from two host commands: `importScan` (what each source holds, item
 * by item) and `importApply` (the ids that were ticked). Nothing here reads a disk. This file
 * relies on the helpers `onboarding.js` defines (`t`, `el`, `$`, `command`), which are
 * available by the time anything here runs.
 */

'use strict';

/** Icon and wording of each category, in the order they are shown. */
const IMPORT_CATEGORIES = {
	packages: { icon: '📦', title: 'impCatPackages', hint: 'impHintPackages' },
	preferences: { icon: '⚙️', title: 'impCatPreferences', hint: 'impHintPreferences' },
	providers: { icon: '🔌', title: 'impCatProviders', hint: 'impHintProviders' },
	mcp: { icon: '🧰', title: 'impCatMcp', hint: 'impHintMcp' },
	skills: { icon: '🎯', title: 'impCatSkills', hint: 'impHintSkills' },
	memory: { icon: '🧠', title: 'impCatMemory', hint: 'impHintMemory' },
	sessions: { icon: '💬', title: 'impCatSessions', hint: 'impHintSessions' },
	logins: { icon: '🔑', title: 'impCatLogins', hint: 'impHintLogins' },
	themes: { icon: '🎨', title: 'impCatThemes', hint: 'impHintThemes' },
	extensions: { icon: '🧩', title: 'impCatExtensions', hint: 'impHintExtensions' },
	editorSettings: { icon: '🛠️', title: 'impCatEditorSettings', hint: 'impHintEditorSettings' },
	keybindings: { icon: '⌨️', title: 'impCatKeybindings', hint: 'impHintKeybindings' },
	snippets: { icon: '✂️', title: 'impCatSnippets', hint: 'impHintSnippets' },
};

const importView = {
	/** `undefined` until the first scan answers. */
	catalog: undefined,
	/** The source card that is showing: `pi` or `vscode:<product>`. */
	active: 'pi',
	/** Ticked ids per source key, then category: a Set of ids, or `true` for a bulk category. */
	picked: new Map(),
	/** The categories that are open. */
	open: new Set(),
	/** What each category's filter box holds. */
	filters: new Map(),
	busy: false,
	/** The outcome of the last import, while it is on screen. */
	result: undefined,
	/** Whether closing goes back to the wizard (true) or closes the window (false). */
	embedded: true,
	scanError: undefined,
};

function importSources() {
	const sources = [];
	if (importView.catalog) {
		sources.push({ key: 'pi', source: 'pi', product: 'pi', name: t('impSourcePi'), catalog: importView.catalog.pi });
		for (const entry of importView.catalog.vscode) {
			sources.push({ key: `vscode:${entry.product}`, source: 'vscode', product: entry.product, name: entry.name, catalog: entry });
		}
	}
	return sources;
}

function importActive() {
	return importSources().find(source => source.key === importView.active);
}

function importPickedFor(key) {
	if (!importView.picked.has(key)) {
		importView.picked.set(key, new Map());
	}
	return importView.picked.get(key);
}

/** How many things are ticked in one category (bulk counts as everything it holds). */
function importTicked(source, category) {
	const mine = importPickedFor(source.key).get(category.id);
	if (mine === true) {
		return category.count;
	}
	return mine instanceof Set ? mine.size : 0;
}

function importTotalTicked(source) {
	return source.catalog.categories.reduce((sum, category) => sum + importTicked(source, category), 0);
}

function importTotalFound(source) {
	return source.catalog.categories.reduce((sum, category) => sum + category.count, 0);
}

/** The ids as the host wants them: a list per category, `'all'` for a bulk one. */
function importChoiceFor(source) {
	const choice = {};
	for (const category of source.catalog.categories) {
		const mine = importPickedFor(source.key).get(category.id);
		if (mine === true) {
			choice[category.id] = category.bulk ? 'all' : category.items.map(item => item.id);
		} else if (mine instanceof Set && mine.size > 0) {
			choice[category.id] = [...mine];
		}
	}
	return choice;
}

function importSetAll(source, category, on) {
	const picked = importPickedFor(source.key);
	if (!on) {
		picked.delete(category.id);
	} else if (category.bulk) {
		picked.set(category.id, true);
	} else {
		picked.set(category.id, new Set(category.items.map(item => item.id)));
	}
}

function importToggleItem(source, category, id, on) {
	const picked = importPickedFor(source.key);
	const current = picked.get(category.id);
	const set = current instanceof Set ? current : new Set();
	if (on) {
		set.add(id);
	} else {
		set.delete(id);
	}
	if (set.size === 0) {
		picked.delete(category.id);
	} else {
		picked.set(category.id, set);
	}
}

/* ------------------------------------------------------------------ *
 * Opening and closing
 * ------------------------------------------------------------------ */

async function openImportView(options) {
	importView.embedded = options?.embedded !== false;
	importView.result = undefined;
	$('import-view').hidden = false;
	document.body.classList.add('import-open');
	renderImportView();
	await scanImport();
}

function closeImportView() {
	if (importView.embedded) {
		$('import-view').hidden = true;
		document.body.classList.remove('import-open');
		return;
	}
	void window.picode.finish({});
}

async function scanImport() {
	importView.scanError = undefined;
	try {
		// The host wraps every answer as `{ ok, data }`.
		importView.catalog = await command('importScan', {}).then(answer => ({ pi: (answer.data ?? answer).pi, vscode: (answer.data ?? answer).vscode ?? [] }));
		const sources = importSources();
		const withItems = sources.find(source => source.catalog.found && importTotalFound(source) > 0);
		if (!sources.some(source => source.key === importView.active) || (importTotalFound(importActive()) === 0 && withItems)) {
			importView.active = (withItems ?? sources[0]).key;
		}
	} catch (error) {
		importView.scanError = error instanceof Error ? error.message : String(error);
	}
	renderImportView();
}

async function runImportView() {
	const source = importActive();
	if (!source || importView.busy) {
		return;
	}
	importView.busy = true;
	renderImportView();
	try {
		const answer = await command('importApply', {
			source: source.source,
			product: source.source === 'vscode' ? source.product : undefined,
			choice: importChoiceFor(source),
		});
		const outcome = answer.data ?? answer;
		importView.result = { source, categories: outcome.categories ?? [], queued: outcome.queuedExtensions ?? [] };
		importView.picked.delete(source.key);
	} catch (error) {
		importView.result = { source, error: error instanceof Error ? error.message : String(error), categories: [], queued: [] };
	}
	importView.busy = false;
	renderImportView();
	// What was brought across changes what there is left to bring.
	void scanImport();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderImportView() {
	const root = $('import-view');
	if (root.hidden) {
		return;
	}
	root.replaceChildren(
		el('div', { class: 'imp-shell' },
			renderImportHeader(),
			importView.result ? renderImportResult() : renderImportBody(),
		),
	);
}

function renderImportHeader() {
	return el('header', { class: 'imp-header' },
		el('div', { class: 'imp-heading' },
			el('h2', { text: `📥 ${t('impTitle')}` }),
			el('p', { class: 'imp-lead', text: t('impLead') }),
		),
		el('button', { class: 'imp-close', type: 'button', title: t('impClose'), 'aria-label': t('impClose'), text: '×', onclick: closeImportView }),
	);
}

function renderImportBody() {
	if (importView.scanError) {
		return el('div', { class: 'imp-empty' }, el('p', { text: `⚠️ ${t('impScanFailed')}` }), el('p', { class: 'imp-note', text: importView.scanError }), el('button', { class: 'imp-link', type: 'button', text: t('impRetry'), onclick: () => void scanImport() }));
	}
	if (!importView.catalog) {
		return el('div', { class: 'imp-empty' }, el('p', { text: t('impScanning') }));
	}
	const source = importActive();
	return el('div', { class: 'imp-body' },
		el('nav', { class: 'imp-sources', 'aria-label': t('impSources') }, importSources().map(renderImportSource)),
		el('section', { class: 'imp-main' }, source ? renderImportCategories(source) : null),
		renderImportFooter(source),
	);
}

function renderImportSource(source) {
	const found = importTotalFound(source);
	const active = source.key === importView.active;
	const icon = source.source === 'pi'
		? el('img', { class: 'imp-source-mark', src: 'media/picode.svg', alt: '' })
		: el('span', { class: 'imp-source-emoji', text: '🖥️', 'aria-hidden': 'true' });
	return el('button', {
		class: `imp-source${active ? ' is-active' : ''}${found === 0 ? ' is-empty' : ''}`,
		type: 'button',
		'aria-pressed': String(active),
		onclick: () => { importView.active = source.key; importView.result = undefined; renderImportView(); },
	},
		icon,
		el('span', { class: 'imp-source-text' },
			el('strong', { text: source.name }),
			el('span', { text: found === 0 ? t('impNothingHere') : t('impFound', found) }),
		),
	);
}

function renderImportCategories(source) {
	const categories = source.catalog.categories;
	if (categories.length === 0) {
		return el('div', { class: 'imp-empty' },
			el('p', { class: 'imp-empty-title', text: `🔎 ${source.source === 'pi' ? t('impNoPi') : t('impNoVsCode')}` }),
			el('button', { class: 'imp-link', type: 'button', text: t('impRescan'), onclick: () => void scanImport() }),
		);
	}
	return el('div', { class: 'imp-list' }, categories.map(category => renderImportCategory(source, category)));
}

function renderImportCategory(source, category) {
	const meta = IMPORT_CATEGORIES[category.id] ?? { icon: '📄', title: category.id, hint: '' };
	const ticked = importTicked(source, category);
	const state = ticked === 0 ? 'none' : ticked >= category.count ? 'all' : 'some';
	const expandable = !category.bulk && category.items.length > 0;
	const isOpen = expandable && importView.open.has(`${source.key}/${category.id}`);

	const master = el('input', { type: 'checkbox', class: 'imp-check', checked: state === 'all', 'aria-label': t(meta.title) });
	master.indeterminate = state === 'some';
	master.addEventListener('change', event => { importSetAll(source, category, event.target.checked); renderImportView(); });

	const head = el('div', { class: 'imp-cat-head' },
		master,
		el('button', {
			class: 'imp-cat-toggle', type: 'button', 'aria-expanded': String(isOpen),
			onclick: () => {
				if (!expandable) { importSetAll(source, category, state !== 'all'); renderImportView(); return; }
				const key = `${source.key}/${category.id}`;
				if (importView.open.has(key)) { importView.open.delete(key); } else { importView.open.add(key); }
				renderImportView();
			},
		},
			el('span', { class: 'imp-cat-icon', text: meta.icon, 'aria-hidden': 'true' }),
			el('span', { class: 'imp-cat-text' },
				el('strong', { text: t(meta.title) }),
				el('span', { text: t(meta.hint) }),
			),
			el('span', { class: `imp-badge${state === 'none' ? '' : ' is-on'}`, text: category.bulk ? String(category.count) : `${ticked}/${category.count}` }),
			expandable ? el('span', { class: `imp-chevron${isOpen ? ' is-open' : ''}`, text: '›', 'aria-hidden': 'true' }) : null,
		),
	);
	return el('div', { class: `imp-cat${category.sensitive ? ' is-sensitive' : ''}${state === 'none' ? '' : ' is-picked'}` },
		head,
		category.sensitive && state !== 'none' ? el('p', { class: 'imp-warning', text: `🔒 ${t('impLoginsWarning')}` }) : null,
		isOpen ? renderImportItems(source, category) : null,
	);
}

function renderImportItems(source, category) {
	const filterKey = `${source.key}/${category.id}`;
	const query = (importView.filters.get(filterKey) ?? '').toLowerCase();
	const mine = importPickedFor(source.key).get(category.id);
	const items = category.items.filter(item => query === '' || item.label.toLowerCase().includes(query));
	const rows = items.slice(0, 200).map(item => {
		const box = el('input', { type: 'checkbox', class: 'imp-check', checked: mine instanceof Set && mine.has(item.id) });
		box.addEventListener('change', event => { importToggleItem(source, category, item.id, event.target.checked); renderImportView(); });
		return el('label', { class: 'imp-row' },
			box,
			el('span', { class: 'imp-row-label', text: item.label }),
			item.detail ? el('span', { class: 'imp-pill', text: item.detail }) : null,
		);
	});
	const search = category.items.length > 8
		? (() => {
			const input = el('input', { class: 'imp-search', type: 'search', placeholder: t('impSearch'), value: importView.filters.get(filterKey) ?? '' });
			input.addEventListener('input', event => {
				importView.filters.set(filterKey, event.target.value);
				renderImportView();
				const again = document.querySelector('.imp-search');
				if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
			});
			return input;
		})()
		: null;
	return el('div', { class: 'imp-items' },
		search,
		rows.length > 0 ? rows : el('p', { class: 'imp-none', text: t('impNoMatch') }),
		items.length > 200 ? el('p', { class: 'imp-none', text: t('impMore', items.length - 200) }) : null,
	);
}

function renderImportFooter(source) {
	const count = source ? importTotalTicked(source) : 0;
	const total = source ? importTotalFound(source) : 0;
	return el('footer', { class: 'imp-footer' },
		el('div', { class: 'imp-footer-left' },
			el('span', { class: 'imp-count', text: count === 0 ? t('impNoneSelected') : t('impSelected', count) }),
			total > 0 ? el('button', { class: 'imp-link', type: 'button', text: count >= total ? t('impClear') : t('impAll'), onclick: () => {
				for (const category of source.catalog.categories) {
					// Logins stay out of "select all": that one is always a deliberate tick.
					importSetAll(source, category, count < total && !category.sensitive);
				}
				renderImportView();
			} }) : null,
		),
		el('button', {
			class: 'primary', type: 'button', disabled: count === 0 || importView.busy,
			text: importView.busy ? t('impImporting') : t('impDo', count),
			onclick: () => void runImportView(),
		}),
	);
}

function renderImportResult() {
	const { result } = importView;
	const added = result.categories.reduce((sum, category) => sum + (category.added ?? 0), 0);
	const failed = result.categories.some(category => category.status === 'failed');
	return el('div', { class: 'imp-result' },
		el('div', { class: 'imp-result-head' },
			el('span', { class: 'imp-result-icon', text: result.error || (failed && added === 0) ? '⚠️' : '✅', 'aria-hidden': 'true' }),
			el('h3', { text: result.error ? t('impFailed') : t('impFinished', added) }),
		),
		result.error ? el('p', { class: 'imp-lead', text: result.error }) : null,
		el('ul', { class: 'imp-result-list' }, result.categories.map(category => {
			const meta = IMPORT_CATEGORIES[category.category] ?? { icon: '📄', title: category.category };
			return el('li', { class: `is-${category.status}` },
				el('span', { class: 'imp-cat-icon', text: meta.icon, 'aria-hidden': 'true' }),
				el('strong', { text: t(meta.title) }),
				el('span', { class: 'imp-result-note', text: category.status === 'failed' ? t('impResultFailed') : [category.added > 0 ? t('impAdded', category.added) : '', category.skipped > 0 ? t('impKept', category.skipped) : ''].filter(Boolean).join(' · ') || t('impResultNothing') }),
			);
		})),
		result.queued.length > 0 ? el('p', { class: 'imp-note', text: `🧩 ${t('impQueued', result.queued.length)}` }) : null,
		el('div', { class: 'imp-result-actions' },
			el('button', { class: 'imp-link', type: 'button', text: t('impMore2'), onclick: () => { importView.result = undefined; renderImportView(); } }),
			el('button', { class: 'primary', type: 'button', text: t('impDone'), onclick: closeImportView }),
		),
	);
}

/* The editor can ask for this view while the window is already open. */
window.picode.onShowImport?.(() => void openImportView({ embedded: document.body.dataset.mode !== 'import' }));
