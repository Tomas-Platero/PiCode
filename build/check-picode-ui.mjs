/*
 * check-picode-ui — what PiCode's own look has to be inside a pack.
 *
 * Three things this file guards, each one invisible until a build ships it wrong:
 *
 *   1. the Activity Bar (outline icons, two-block layout, theme colours),
 *   2. the PiCode colour family (five themes, the default being PiCode Dark),
 *   3. the extensions flow (installing never asks about publisher trust).
 *
 * A screenshot proves one theme on one machine; these assertions prove the next build.
 *
 *   node build/check-picode-ui.mjs [pack folder]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.argv[2] ?? 'PiCode-win32-x64';
const OUT = join(APP, 'resources', 'app', 'out', 'vs');
const MEDIA = join(OUT, 'workbench', 'contrib', 'picode', 'browser', 'media', 'tabler');
const THEMES = join(APP, 'resources', 'app', 'extensions', 'theme-defaults', 'themes');

const failures = [];
const fail = message => failures.push(message);

/** The declarations of one minified rule, or '' when the selector is not there. */
function rule(css, selector) {
	const start = css.indexOf(`${selector}{`);
	if (start === -1) {
		return '';
	}
	return css.slice(start + selector.length + 1, css.indexOf('}', start));
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

// --------------------------------------------------------------------------- Activity Bar

const ICONS = ['folders', 'search', 'git-branch', 'bug', 'puzzle', 'settings'];
for (const icon of ICONS) {
	const file = join(MEDIA, `${icon}.svg`);
	if (!existsSync(file)) {
		fail(`missing asset: ${file}`);
		continue;
	}

	const svg = readFileSync(file, 'utf8');
	if (!svg.includes('viewBox="0 0 24 24"') || !svg.includes('stroke-width="2"')) {
		fail(`${icon}.svg is not the expected 24px outline drawing`);
	}
}

// A packed build fuses the workbench into one file, so the source modules only exist in a
// dev tree: look in the module when it is there, in the main bundle otherwise.
const bundled = existsSync(join(OUT, 'workbench', 'contrib', 'picode', 'browser', 'picodeActivityBarIcons.js'))
	? readFileSync(join(OUT, 'workbench', 'contrib', 'picode', 'browser', 'picodeActivityBarIcons.js'), 'utf8')
	: readFileSync(join(OUT, 'workbench', 'workbench.desktop.main.js'), 'utf8');
if (!bundled.includes('media/tabler/')) {
	fail('no code in the pack points at media/tabler/');
}
if (!bundled.includes('div.global-activity-bar')) {
	fail('the bottom block has no class, so the layout cannot pin it');
}

const css = readFileSync(join(OUT, 'workbench', 'workbench.desktop.main.css'), 'utf8');

const content = rule(css, '.monaco-workbench .activitybar>.content');
for (const declaration of ['display:flex', 'flex-direction:column', 'min-height:0', 'overflow:hidden']) {
	if (!content.includes(declaration)) {
		fail(`the activity bar column lost \`${declaration}\``);
	}
}

const top = rule(css, '.monaco-workbench .activitybar>.content>.composite-bar');
for (const declaration of ['flex:1 1 auto', 'min-height:0', 'overflow-y:auto']) {
	if (!top.includes(declaration)) {
		fail(`the top block is not flexible/scrollable: \`${declaration}\` is missing`);
	}
}
if (css.includes('.activitybar>.content>.composite-bar{margin-bottom:auto}')) {
	fail('the old margin-based pinning is back, fighting the flex layout');
}

const bottom = rule(css, '.monaco-workbench .activitybar>.content>.global-activity-bar');
if (!bottom.includes('flex:0 0 auto')) {
	fail('the bottom block is not pinned (flex:0 0 auto)');
}

if (!css.includes('.composite-bar>.monaco-action-bar.vertical .action-item+.action-item{margin-top:var(--activity-bar-action-gap, 0px)}')) {
	fail('the gap-between-items rule is not in the bundled stylesheet');
}

// --------------------------------------------------------------------------- Colour family

const FAMILY = [
	{ file: 'picode-dark.json', name: 'PiCode Dark', type: 'dark', activity: '#3B82F6' },
	{ file: 'picode-light.json', name: 'PiCode Light', type: 'light', activity: '#0284C7' },
	{ file: 'picode-neon-minimal.json', name: 'PiCode Neon Minimal', type: 'dark', activity: '#00F0FF' },
	{ file: 'picode-slate.json', name: 'PiCode Slate', type: 'dark', activity: '#38BDF8' },
	{ file: 'picode-sepia.json', name: 'PiCode Sepia', type: 'light', activity: '#B45309' },
	{ file: 'picode-synthwave.json', name: 'PiCode Synthwave', type: 'dark', activity: '#FF79C6' },
];

for (const theme of FAMILY) {
	const path = join(THEMES, theme.file);
	if (!existsSync(path)) {
		fail(`missing theme: ${theme.file}`);
		continue;
	}

	const json = readJson(path);
	if (json.name !== theme.name || json.type !== theme.type) {
		fail(`${theme.file} is ${json.name}/${json.type}, expected ${theme.name}/${theme.type}`);
	}
	if (!json.include) {
		fail(`${theme.file} does not inherit a base theme`);
	}
	if (json.colors['activityBar.foreground'] !== theme.activity) {
		fail(`${theme.name}: activityBar.foreground is ${json.colors['activityBar.foreground']}`);
	}
}

const themePackage = readJson(join(APP, 'resources', 'app', 'extensions', 'theme-defaults', 'package.json'));
const contributed = new Set(themePackage.contributes.themes.map(theme => theme.id));
for (const theme of FAMILY) {
	if (!contributed.has(theme.name)) {
		fail(`theme-defaults does not contribute ${theme.name}`);
	}
}

if (!bundled.includes('PiCode Dark')) {
	fail('"PiCode Dark" is not in the workbench bundle: the default theme constant did not ship');
}

// --------------------------------------------------------------------------- Extensions flow

// The trust dialog is gone when neither its messages nor its buttons are in the localized
// strings the build collected. This is the only place those strings ever lived.
const nls = readFileSync(join(APP, 'resources', 'app', 'out', 'nls.messages.json'), 'utf8');
for (const gone of ['Do you trust the publisher', 'Trust Publisher &', 'is [**not** verified]']) {
	if (nls.includes(gone)) {
		fail(`the publisher trust dialog is back: "${gone}" is in the localized strings`);
	}
}

// The first-run setup offers the family, PiCode Dark first and featured.
const onboarding = readFileSync(join(APP, 'resources', 'onboarding', 'onboarding.js'), 'utf8');
const firstTheme = onboarding.match(/const THEMES = \[\n[\s\S]*?\{\s*id: '([^']+)'/);
if (!firstTheme || firstTheme[1] !== 'PiCode Dark') {
	fail(`the setup page offers ${firstTheme ? firstTheme[1] : 'nothing'} first, expected PiCode Dark`);
}

// ...and it is the default that gets written on a first run, not just a card on screen.
if (!onboarding.includes("const DEFAULT_THEME = 'PiCode Dark'") || !onboarding.includes("setTheme', { id: DEFAULT_THEME }")) {
	fail('the setup page no longer records PiCode Dark as the default theme');
}

// --------------------------------------------------------------------------- Result

if (failures.length) {
	console.error(`✗ ${failures.length} problem(s) in ${APP}`);
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log(`✓ bar, ${FAMILY.length} themes, one-click install and the setup page all check out in ${APP}`);
