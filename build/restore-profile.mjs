#!/usr/bin/env node
/*
 * Puts the owner's PiCode profile back after a build.
 *
 * The pack deletes the platform directory before writing it, so `data/` — settings, the profile
 * of pi, window state, history — goes with it. A collaborator starting from a fresh tree has
 * nothing there to lose; somebody building over the editor they use every day does, and losing it
 * to a build is not a trade anyone agreed to.
 *
 * So the runner copies `data/` aside before the build and this puts it back afterwards, file by
 * file: the editor is usually **running** while that happens and holds some of its caches open, and
 * a locked cache must not cost the settings.
 *
 * It also takes out the settings that describe pi models this product no longer has, so a profile
 * carried over from an older PiCode does not keep switches that answer nothing.
 *
 * Usage: node dev/restore-profile.mjs [--pack <dir>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const packFlag = args.indexOf('--pack');
const PACK = packFlag === -1 ? path.join(REPO, 'PiCode-Win32-x64') : path.resolve(args[packFlag + 1]);

const DATA = path.join(PACK, 'data');
const BACKUP = path.join(REPO, '.scratch', 'payload-data-backup');

/** Settings whose pi does not exist any more: the old panel's transport and voice features. */
const RETIRED_SETTINGS = [
	'picode.pi.executablePath',
	'picode.pi.extraArgs',
	'picode.pi.transport',
	'picode.pi.defaultModel',
];

if (!fs.existsSync(BACKUP)) {
	process.stdout.write('no profile backup: nothing to restore\n');
	process.exit(0);
}

let copied = 0;
const locked = [];

/** A copy that keeps going: a cache the editor holds open is not a reason to lose the settings. */
function copyOver(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		try {
			if (entry.isDirectory()) {
				copyOver(source, target);
			} else {
				fs.copyFileSync(source, target);
				copied += 1;
			}
		} catch {
			locked.push(target);
		}
	}
}

copyOver(BACKUP, DATA);

const settingsPath = path.join(DATA, 'user-data', 'User', 'settings.json');
if (fs.existsSync(settingsPath)) {
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
		const changes = [];
		for (const key of RETIRED_SETTINGS) {
			if (key in settings) {
				delete settings[key];
				changes.push(`removed ${key}`);
			}
		}
		// Upstream's default hides the chat, and the chat is where this product's agent answers.
		if (settings['chat.disableAIFeatures'] !== false) {
			settings['chat.disableAIFeatures'] = false;
			changes.push('chat.disableAIFeatures = false (the chat is pi\'s surface)');
		}
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		for (const change of changes) {
			process.stdout.write(`${change}\n`);
		}
	} catch (error) {
		process.stdout.write(`the settings could not be read (${error instanceof Error ? error.message : String(error)})\n`);
	}
}

process.stdout.write(`profile restored: ${copied} files into ${DATA}\n`);
if (locked.length > 0) {
	process.stdout.write(`  ${locked.length} file(s) held open by the editor and left as they were (caches)\n`);
}
