#!/usr/bin/env node
// PiCode: the update window says "Visual Studio Code".
//
// `inno_updater.exe` is VS Code's prebuilt updater: it installs an update and owns the little
// progress window the owner sees while PiCode restarts. Its strings are compiled in, so the
// rebrand has to reach the binary.
//
// The window is the DIALOG resource (RT_DIALOG, id 1001) it carries: the caption, the placeholder
// text ("Updating Visual Studio Code...", replaced at run time by the message the installer passes
// in - `{cm:UpdatingVisualStudioCode}`, which the .isl files already translate as PiCode) and a
// msctls_progress32 bar. The VERSION resource (RT_VERSION, id 1) carries ProductName "Visual Studio
// Code" and FileDescription "VSCode Inno Updater" as well, and the build's rcedit stamp rewrites
// those, but nothing in the toolchain touches a dialog resource.
//
// Every replacement keeps the original length, right-padded with spaces:
//
//   * a DLGTEMPLATE stores the caption, the font and the control text as NUL-terminated strings
//     laid out one after another, so a shorter string would shift the pointsize that follows it
//     and corrupt the dialog;
//   * VERSIONINFO values are prefixed with their byte length, so a shorter one would need that
//     prefix rewritten.
//
// Same length, same bytes, only the words change. Trailing spaces in a title bar or a control are
// invisible. Run from the repository root; re-run it whenever the vendored binary is replaced.
// It is idempotent: already-patched strings are simply not found again.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'picode-source', 'build', 'win32', 'inno_updater.exe');

/**
 * Longest first: "Updating Visual Studio Code..." contains the bare brand, and it needs its own
 * replacement so the ellipsis does not end up behind a run of spaces.
 */
const replacements = [
	['Updating Visual Studio Code...', 'Updating PiCode...'],
	['Visual Studio Code - Updater', 'PiCode - Updater'],
	['Visual Studio Code', 'PiCode'],
];

const buffer = readFileSync(target);
let patched = 0;

for (const [from, to] of replacements) {
	if (to.length > from.length) {
		throw new Error(`"${to}" does not fit in "${from}" (${to.length} > ${from.length})`);
	}
	const padded = to.padEnd(from.length, ' ');
	const needle = Buffer.from(from, 'utf16le');
	const patch = Buffer.from(padded, 'utf16le');
	if (needle.length !== patch.length) {
		throw new Error(`length mismatch for "${from}"`);
	}

	let at = buffer.indexOf(needle);
	while (at !== -1) {
		patch.copy(buffer, at);
		patched += 1;
		at = buffer.indexOf(needle, at + needle.length);
	}
}

if (patched === 0) {
	console.log('inno_updater.exe: already branded, nothing to do');
} else {
	writeFileSync(target, buffer);
	console.log(`inno_updater.exe: rebranded ${patched} string(s)`);
}
