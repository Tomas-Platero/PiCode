/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Status section's layout, pinned.
 *
 * The section had three layout bugs that only showed on a narrow panel: descriptions squeezed
 * into a one-word column, buttons at `width: 100%` overflowing the card, and a five-field strip
 * breaking into uneven lines. None of them is a logic bug, so no behaviour test would ever catch
 * them again — this file is the guard instead.
 *
 * It reads the section's own source and stylesheet and asserts the rules that keep the panel
 * readable at ~500px. It is deliberately a contract, not a snapshot: it says what must be true of
 * the layout (flexible text column, fixed button column, no full-width buttons, no fixed colours)
 * and leaves the exact values free.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CSS = readFileSync(new URL('../../../src/vs/workbench/contrib/picode/browser/media/picodeStatusSection.css', import.meta.url), 'utf8');
const SOURCE = readFileSync(new URL('../../../src/vs/workbench/contrib/picode/browser/picodeStatusSection.ts', import.meta.url), 'utf8');

/** The body of one CSS rule, by its selector at the start of a line. */
function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CSS);
	assert.ok(match, `the rule ${selector} is missing from the section's stylesheet`);
	return match[1];
}

test('a row splits into a flexible text column and a button column that never shrinks', () => {
	assert.match(rule('.row'), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/, 'the row must be minmax(0, 1fr) auto');
	// Without this, a long word or an icon inside the text cell can push the cell wider than the
	// panel and the button out of the card.
	assert.match(rule('.row .text'), /min-width:\s*0/);
	assert.match(rule('.row .value'), /min-width:\s*0/);
});

test('the Host strip is content-sized, and its values stay on one line', () => {
	assert.match(rule('.kv'), /grid-template-columns:\s*auto\s+auto\s+minmax\(0,\s*1fr\)/, 'three equal columns split "Own profile" in two');
	assert.match(rule('.kv .val'), /white-space:\s*nowrap/);
	assert.match(rule('.kv .val'), /text-overflow:\s*ellipsis/);
	assert.match(rule('.kv > div'), /min-width:\s*0/);
});

test('no button is full width, and a column of them lines up', () => {
	assert.doesNotMatch(CSS, /width:\s*100%/, 'a full-width button is what ran out of the panel');
	assert.match(rule('.picode-status-btn.monaco-button'), /width:\s*auto/);
	assert.match(rule('.picode-status-btn.monaco-button'), /min-width:\s*\d+px/);
});

test('the destructive action is the only one painted with the danger colour', () => {
	assert.match(rule('.picode-status-btn.monaco-button.danger'), /color:\s*var\(--vscode-errorForeground\)/);
	const dangerRules = CSS.match(/\.danger[^{]*\{[^}]*\}/g) ?? [];
	assert.equal(dangerRules.length > 0, true);
	for (const block of dangerRules) {
		assert.match(block, /--vscode-/, 'a danger rule may only use theme variables');
	}
});

test('the stylesheet takes every colour from the theme', () => {
	// A fixed colour would ignore the theme in force: light themes would get unreadable text.
	assert.doesNotMatch(CSS, /#[0-9a-fA-F]{3,8}\b/, 'no hex colours');
	assert.doesNotMatch(CSS, /\b(rgba?|hsla?)\(/, 'no rgb()/hsl() colours');
});

test('the section cannot scroll sideways', () => {
	assert.match(rule('.picode-status-section'), /overflow-x:\s*hidden/);
	assert.match(rule('.picode-status-card'), /min-width:\s*0/);
});

test('the section scrolls inside the page\'s box instead of losing its cards', () => {
	// The page gives this section a bounded, clipped height: without its own scroll the last cards
	// (Actions among them) were unreachable, and a plain div does not get the workbench's scrollbars.
	assert.match(rule('.picode-status-section'), /height:\s*100%/);
	assert.match(rule('.picode-status-section'), /min-height:\s*0/);
	assert.match(rule('.picode-status-section'), /overflow-y:\s*auto/);
	assert.match(rule('.picode-status-section > *'), /flex:\s*0 0 auto/, 'cards must not be squeezed to fit the box');
	assert.match(CSS, /::-webkit-scrollbar-thumb\s*\{[^}]*--vscode-scrollbarSlider-background/, 'the scrollbar follows the theme');
});

test('the DOM the section builds matches the layout: buttons live in a header or a row', () => {
	// A card's buttons sit in its own header bar, and a row's switch is a child of that row (its own
	// grid column) — never appended to the card after the text, the shape that produced "text on one
	// side, button on the other".
	assert.match(SOURCE, /const bar = DOM\.append\(header, \$\('\.card-actions'\)\);[\s\S]*?this\.addButton\(bar, action\)/);
	assert.match(SOURCE, /private addRowButton\(card: HTMLElement[\s\S]*?const side = DOM\.append\(row, \$\('\.row-side'\)\);[\s\S]*?this\.addButton\(side, action\)/);
});

test('a button stays busy while its command runs, and the page reads the status again after', () => {
	assert.match(SOURCE, /private async run\(action: IAction, button: Button\)[\s\S]*?this\.setBusy\(button, true\)[\s\S]*?await this\.commandService\.executeCommand[\s\S]*?this\.refresh\(true\)/);
	// A reading that changed nothing must not rebuild the cards (and swap a button out from under a click).
	assert.match(SOURCE, /fingerprint === this\.fingerprint/);
});
