#!/usr/bin/env node
/*
 * What the build is doing, and how much is left.
 *
 * The build prints its phases, but the long ones — installing dependencies, bundling the core,
 * packing the platform directory — go quiet for minutes, so following its log shows nothing for
 * stretches and there is no way to tell "working" from "stuck". It happened: a build sat silent
 * for seven hours.
 *
 * This reads what the build has printed **and what it has written**, and draws one line that
 * keeps moving: the stage, a bar, and an estimate of what is left. The estimate is honest about
 * being one — stages with an exact marker jump; the minutes inside a long stage are a ramp over
 * how long that stage took the last times it ran here.
 *
 * Usage: node dev/build-progress.mjs [log file] [--once]
 *   log file   defaults to the newest `.scratch/build*.log`
 *   --once     print one line and exit, for a caller that wants a snapshot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PACK = path.join(REPO, 'VSCode-win32-x64');
const NODE_MODULES = path.join(REPO, 'vscode', 'node_modules');

/** The newest build log, which is the run the owner is watching. */
function newestLog() {
	const scratch = path.join(REPO, '.scratch');
	try {
		const logs = fs.readdirSync(scratch)
			.filter(name => /^build\d*\.log$/.test(name))
			.map(name => path.join(scratch, name))
			.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
		return logs[0];
	} catch {
		return undefined;
	}
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const logFile = args.find(argument => !argument.startsWith('--')) ?? newestLog();

/**
 * The stages, in order, with how much of the work each one is.
 *
 * The weights come from the runs on this machine (a `-s` rebuild: dependencies and the core
 * compile are the two big ones; the pack is the third) and the `because` line is what makes the
 * bar move inside a stage that has no marker of its own.
 */
const STAGES = [
	{ id: 'prepare', label: 'preparando el código de VS Code', weight: 4, expectedSeconds: 60 },
	{ id: 'dependencies', label: 'instalando dependencias', weight: 30, expectedSeconds: 300 },
	{ id: 'connector', label: 'compilando el conector', weight: 3, expectedSeconds: 20 },
	{ id: 'core', label: 'compilando el núcleo', weight: 27, expectedSeconds: 120 },
	{ id: 'pack', label: 'empaquetando el editor', weight: 30, expectedSeconds: 300 },
	{ id: 'stage', label: 'sellando la distribución', weight: 6, expectedSeconds: 60 },
];

const stageStarts = STAGES.map((_, index) => STAGES.slice(0, index).reduce((sum, stage) => sum + stage.weight, 0));

/**
 * Where the log says the build is, and whether it ended.
 *
 * Read by **the last marker of each stage**, not by "does the text contain it": the log is
 * cumulative, so a phase named at the top is still in the text an hour later. The stage whose
 * marker appears last is the one the build is in.
 */
function readLog(text) {
	const lines = text.split('\n');
	const lastLine = lines.filter(line => line.trim().length > 0).pop() ?? '';

	if (/== done/.test(text)) {
		return { index: 5, done: 'ok', lastLine };
	}
	// The tail only: a build that recovered from a warning is not a failed build.
	const tail = lines.slice(-8).join('\n');
	if (/errored|error TS|Error: |exited with code [1-9]|command not found/i.test(tail)) {
		return { index: 5, done: 'failed', lastLine };
	}

	const markers = [
		{ index: 0, pattern: /== phase 1\/8|== phases 2-5/ },
		{ index: 1, pattern: /== phase 6\/8|npm ci|Installing dependencies/ },
		{ index: 2, pattern: /== phase 6b\/8|connector compiled/ },
		{ index: 3, pattern: /Starting compile-src|Finished compile-src|Starting .*compilation/ },
		{ index: 4, pattern: /Bundled extension:/ },
		{ index: 5, pattern: /== phase 8\/8|--- step [0-9]\/6|staging complete/ },
	];

	// The marker that appears latest in the text wins; ties go to the later stage, because a stage
	// that has started is further along than one that ended.
	let index = 0;
	let lastAt = -1;
	for (const marker of markers) {
		const at = lines.reduce((found, line, position) => (marker.pattern.test(line) ? position : found), -1);
		if (at > lastAt) {
			lastAt = at;
			index = marker.index;
		}
	}
	return { index, done: undefined, lastLine };
}

/** How far the dependencies got, read from the tree: the install is what fills it. */
function dependencyFraction() {
	try {
		const entries = fs.readdirSync(NODE_MODULES).length;
		// A complete install lands around nine hundred entries here; the marker is the compiler,
		// which is the package the rest of the build needs.
		const complete = fs.existsSync(path.join(NODE_MODULES, '@typescript', 'native', 'lib', 'tsc.js'));
		return complete ? 1 : Math.min(0.95, entries / 900);
	} catch {
		return 0;
	}
}

/** How far the pack got, read from the directory it is writing. */
function packFraction() {
	try {
		const out = path.join(PACK, 'resources', 'app', 'out');
		const megabytes = directoryMegabytes(out);
		// A packed editor's `out` is around eighty megabytes; anything above counts as done.
		return Math.min(1, megabytes / 80);
	} catch {
		return 0;
	}
}

function directoryMegabytes(directory) {
	let total = 0;
	const walk = current => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			try {
				if (entry.isDirectory()) {
					walk(full);
				} else {
					total += fs.statSync(full).size;
				}
			} catch {
				// A file that disappears between the listing and the stat is one the pack is
				// rewriting, which is exactly the moment this is being asked for.
			}
		}
	};
	try {
		walk(directory);
	} catch {
		return 0;
	}
	return total / (1024 * 1024);
}

/** The percentage of the whole, from the stage and how far inside it the build is. */
function percentageFor(index, startedAt, now) {
	const before = stageStarts[index];
	if (index === 1) {
		const fraction = dependencyFraction();
		return before + STAGES[index].weight * fraction;
	}
	if (index === 4) {
		const fraction = packFraction();
		if (fraction > 0) {
			return before + STAGES[index].weight * fraction;
		}
	}
	// No signal of its own: a ramp over how long this stage usually takes, capped so the bar never
	// claims to have finished something it has not.
	const elapsed = (now - startedAt) / 1000;
	const fraction = Math.min(0.97, elapsed / STAGES[index].expectedSeconds);
	return before + STAGES[index].weight * fraction;
}

function bar(percentage) {
	const width = 28;
	const filled = Math.max(0, Math.min(width, Math.round((percentage / 100) * width)));
	return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function clock(seconds) {
	const total = Math.max(0, Math.round(seconds));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

if (logFile === undefined || !fs.existsSync(logFile)) {
	process.stderr.write('No build log found. Run the build first, or pass its log file.\n');
	process.exit(2);
}

const startedAt = fs.statSync(logFile).mtimeMs;
let lastDrawn = '';
let ended = false;

function draw() {
	const text = fs.readFileSync(logFile, 'utf8');
	const state = readLog(text);
	const index = state.index ?? 1;
	const now = Date.now();

	if (state.done === 'ok') {
		process.stdout.write(`\r  listo  ${bar(100)} 100%  ·  la build terminó bien, con el editor en VSCode-win32-x64          \n`);
		return true;
	}
	if (state.done === 'failed') {
		process.stdout.write(`\r  fallo  ${bar(100)} ???  ·  la build falló: mira la última línea del registro          \n`);
		process.stdout.write(`  ${state.lastLine}\n`);
		return true;
	}

	const percentage = percentageFor(index, startedAt, now);
	const elapsed = (now - startedAt) / 1000;
	const remaining = percentage > 2 ? (elapsed / percentage) * (100 - percentage) : undefined;
	const line = `\r  ${bar(percentage)} ${String(Math.round(percentage)).padStart(3)}%  ·  ${STAGES[index].label}  ·  ${clock(elapsed)}` +
		(remaining === undefined ? '' : `, quedan ~${clock(remaining)}`) + '   ';

	if (line !== lastDrawn) {
		lastDrawn = line;
		process.stdout.write(line);
	}
	return false;
}

if (once) {
	draw();
	process.stdout.write('\n');
	process.exit(0);
}

process.stdout.write('\n');
const timer = setInterval(() => {
	try {
		ended = draw() || ended;
	} catch (error) {
		process.stdout.write(`\n  no se pudo leer el registro: ${error instanceof Error ? error.message : String(error)}\n`);
		ended = true;
	}
	if (ended) {
		clearInterval(timer);
	}
}, 1000);
