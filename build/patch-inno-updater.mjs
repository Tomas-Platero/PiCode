#!/usr/bin/env node
// PiCode: the updater says "Visual Studio Code".
//
// `inno_updater.exe` is VS Code's prebuilt updater: the installer invokes it while PiCode
// restarts, it paints the little progress window, and it owns the error box when an update
// cannot be installed. Its strings are compiled in, so the rebrand has to reach the binary.
//
// They live in two shapes, and both are branded here:
//
//   1. The DIALOG resource (RT_DIALOG, id 1001): the progress window's caption, its placeholder
//      text ("Updating Visual Studio Code...", replaced at run time by the message the installer
//      passes in - `{cm:UpdatingVisualStudioCode}`, which the .isl files translate as PiCode) and
//      a msctls_progress32 bar. A DLGTEMPLATE stores those as UTF-16, NUL-terminated strings laid
//      out one after another, so a shorter string would shift the pointsize that follows it and
//      corrupt the dialog.
//
//   2. The program's own literals: this is a 32-bit Rust binary, so the failure box the owner
//      actually sees ("Failed to install Visual Studio Code update. ..."), the caption it is
//      shown under, "Visual Studio Code - Updater", "Visual Studio Code is updating...",
//      "Please verify there are no Visual Studio Code processes still executing." and the
//      `vscode-inno-updater-<pid>.log` prefix. They are ANSI bytes packed together with no
//      separators, and a `&str` carries its byte length in the code, so a replacement that
//      changed the length would make the program read a different slice.
//
// Every replacement therefore keeps the original byte length, right-padded with spaces. The
// branded words go at the front and the padding lands at the end of each literal, where it is
// invisible: behind a progress line, or as trailing space in a title bar. The failure box is the
// exception - its caller appends the log file path, so its padding goes at the end of the last
// sentence instead, before the closing blank line. A VERSIONINFO value would be length-prefixed
// too, but that resource is rewritten by the build's rcedit stamp rather than here.
//
// Same length, same bytes, only the words change. Run from the repository root; re-run it
// whenever the vendored binary is replaced. It is idempotent: already-patched strings are simply
// not found again.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'picode-source', 'build', 'win32', 'inno_updater.exe');

/**
 * The UTF-16 dialog resource. Longest first: "Visual Studio Code - Updater" contains the bare
 * brand and needs its own replacement so the line does not end up behind a run of spaces; the
 * same is true of "Updating Visual Studio Code...".
 */
const dialogReplacements = [
	['Updating Visual Studio Code...', 'Updating PiCode...'],
	['Visual Studio Code - Updater', 'PiCode - Updater'],
	['Visual Studio Code', 'PiCode'],
];

/**
 * The program's own ANSI literals. Longest first, and the full literal is always the needle:
 * "Visual Studio Code" sits in the middle of the failure box and of the "processes still
 * executing" line, and replacing only the brand would leave its twelve spare bytes as a gap in
 * the middle of a sentence instead of at the end.
 *
 * The failure box is the one literal whose padding cannot go last: the caller appends the log file
 * path to it, so trailing spaces would indent that path. Its twelve bytes go at the end of the
 * last sentence instead, where the trailing spaces of a line are just as invisible and the path
 * still starts at the left margin.
 */
const literalReplacements = [
	[
		'Failed to install Visual Studio Code update.\n\nUpdates may fail due to anti-virus software and/or runaway processes. Please try restarting your machine before attempting to update again.\n\nPlease read the log file for more information:\n\n',
		'Failed to install PiCode update.\n\nUpdates may fail due to anti-virus software and/or runaway processes. Please try restarting your machine before attempting to update again.\n\nPlease read the log file for more information:            \n\n',
	],
	[
		'\n\nPlease verify there are no Visual Studio Code processes still executing.',
		'\n\nPlease verify there are no PiCode processes still executing.',
	],
	['Visual Studio Code is updating...', 'PiCode is updating...'],
	['Visual Studio Code - Updater', 'PiCode - Updater'],
	['vscode-inno-updater-', 'picode-inno-updater-'],
	['Visual Studio Code', 'PiCode'],
];

/**
 * Replaces every occurrence of each pair, in order, keeping the byte length. `encoding` is what
 * the surrounding bytes are: the dialog resource is UTF-16, the literals are single bytes.
 */
function rebrand(buffer, replacements, encoding) {
	let patched = 0;

	for (const [from, to] of replacements) {
		if (to.length > from.length) {
			throw new Error(`"${to}" does not fit in "${from}" (${to.length} > ${from.length})`);
		}
		const needle = Buffer.from(from, encoding);
		const patch = Buffer.from(to.padEnd(from.length, ' '), encoding);
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

	return patched;
}

const buffer = readFileSync(target);
const patched = rebrand(buffer, dialogReplacements, 'utf16le')
	+ rebrand(buffer, literalReplacements, 'latin1');

if (patched === 0) {
	console.log('inno_updater.exe: already branded, nothing to do');
} else {
	writeFileSync(target, buffer);
	console.log(`inno_updater.exe: rebranded ${patched} string(s)`);
}
