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
const PACK = path.join(REPO, 'PiCode-Win32-x64');
const NODE_MODULES = path.join(REPO, 'picode-source', 'node_modules');

/** The newest build log, which is the run the owner is watching. */
function newestLog() {
	const scratch = path.join(REPO, '.scratch');
	try {
		const logs = fs.readdirSync(scratch)
			.filter(name => /^(build-live|build\d*)\.log$/.test(name))
			.map(name => path.join(scratch, name))
			.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
		return logs[0];
	} catch {
		return undefined;
	}
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const asJson = args.includes('--json');
const logFile = args.find(argument => !argument.startsWith('--')) ?? newestLog();

/**
 * The stages, in order, with how much of the work each one is.
 *
 * The weights come from the runs on this machine (the core compile and the pack are the two big
 * ones, and they always run; the dependency install is the third, and it is skipped when nothing
 * that affects it changed) and the `because` line is what makes the bar move inside a stage that
 * has no marker of its own.
 */
const STAGES = [
	{
		id: 'prepare', label: 'Checking the source', weight: 2, expectedSeconds: 10,
		detail: 'Confirming the tree is the PiCode source, already branded. Seconds: nothing is downloaded or patched here any more.'
	},
	{
		id: 'dependencies', label: 'Getting the pieces it needs', weight: 30, expectedSeconds: 300,
		detail: 'Installing the packages the editor is built with. It runs once: when nothing that affects them changed, it is skipped.'
	},
	{
		id: 'connector', label: 'Compiling the connector', weight: 3, expectedSeconds: 20,
		detail: 'Building the piece that talks to pi, so the editor can reach a model.'
	},
	{
		id: 'core', label: 'Compiling the editor', weight: 27, expectedSeconds: 120,
		detail: 'Turning the source into the program. The screen stays quiet for minutes here, and that is normal.'
	},
	{
		id: 'pack', label: 'Packing it', weight: 30, expectedSeconds: 300,
		detail: 'Copying everything into the folder the editor runs from. Also quiet, also minutes.'
	},
	{
		id: 'stage', label: 'Finishing it off', weight: 6, expectedSeconds: 60,
		detail: 'Naming it PiCode, drawing its icons and writing its defaults. Almost there.'
	},
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
	// The build's output carries colour codes (`Finished \u001b[32mcompile-src\u001b[39m`), and left in
	// they hide the words a marker looks for: `Finished compile-src` is never actually contiguous.
	const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
	const lastLine = lines.filter(line => line.trim().length > 0).pop() ?? '';

	if (/== done/.test(text)) {
		return { index: 5, done: 'ok', lastLine };
	}

	const markers = [
		{ index: 0, pattern: /== phase 1\/5|the source carries the PiCode identity/ },
		{ index: 1, pattern: /  -- dependencies|npm ci|Installing dependencies|the dependencies are the ones/ },
		{ index: 2, pattern: /== phase 2\/5|connector compiled/ },
		{ index: 3, pattern: /Starting compile-src|Starting .*compilation/ },
		{ index: 4, pattern: /Finished compile-src|Bundled extension:|Packing/ },
		{ index: 5, pattern: /== phase 5\/5|--- step [0-9]\/[0-9]|staging complete/ },
	];

	// The furthest stage that has left its mark wins. Not the marker that appears latest in the text:
	// the log is cumulative, "npm ci" comes back around in later phases, and a build that reached
	// phase 8 was being reported as if it were still on its first step.
	let index = 0;
	for (const marker of markers) {
		if (lines.some(line => marker.pattern.test(line))) {
			index = Math.max(index, marker.index);
		}
	}
	const tail = lines.slice(-8).join('\n');
	// The tail only, and only now that the furthest stage is known: a failure used to report
	// the LAST stage always, so a compile error in the connector showed as a failure in staging.
	// The build failed where it stopped, not wherever the failure branch hardcoded.
	if (/errored|error TS|Error: |(^|\n)\s*error:|exited with code [1-9]|command not found/i.test(tail)) {
		return { index, done: 'failed', lastLine };
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

// When the build started. The runner truncates the log before it starts, so the file's own age is
// the answer; the last write is not, and taking it made every estimate nonsense (the log is written
// every second, so "elapsed" was always about a second).
const logStat = fs.statSync(logFile);
/** The runner's own verdict, when it has finished. The log is only a fallback for a run still going. */
/**
 * Whether the log belongs to an older build than the verdict file. A build started by hand through
 * dev/build.sh writes a verdict but no live log, so the log on disk can be the previous run's - and
 * mixing its stages and elapsed time with a fresh verdict told one build's story with another's clock.
 */
function logIsStale() {
	try {
		const status = fs.statSync(path.join(REPO, '.scratch', 'build.status'));
		const log = fs.statSync(logFile);
		return status.mtimeMs > log.mtimeMs;
	} catch {
		return false;
	}
}

function readVerdict() {
	try {
		const code = fs.readFileSync(path.join(REPO, '.scratch', 'build.status'), 'utf8').trim();
		if (code === '') { return undefined; }
		return code === '0' ? 'ok' : 'failed';
	} catch {
		return undefined;
	}
}

const startedAt = (logStat.birthtimeMs && logStat.birthtimeMs <= Date.now()) ? logStat.birthtimeMs : logStat.mtimeMs;
let lastDrawn = '';
let ended = false;

function draw() {
	// The verdict first: a build started by hand writes no live log, so a stale log must not tell this
	// build's story with another build's clock.
	const verdict = readVerdict();
	if (verdict !== undefined && logIsStale()) {
		if (verdict === 'ok') {
			process.stdout.write(`\r  done   ${bar(100)} 100%  -  the build finished, in PiCode-Win32-x64          \n`);
		} else {
			process.stdout.write(`\r  failed ${bar(100)} ???  -  the last build failed: see its own log          \n`);
		}
		return true;
	}

	const text = fs.readFileSync(logFile, 'utf8');
	const state = readLog(text);
	if (state.done === undefined && verdict !== undefined) { state.done = verdict; }
	const index = state.index ?? 1;
	const now = Date.now();

	if (state.done === 'ok') {
		process.stdout.write(`\r  done   ${bar(100)} 100%  -  the build finished, in PiCode-Win32-x64          \n`);
		return true;
	}
	if (state.done === 'failed') {
		process.stdout.write(`\r  failed ${bar(100)} ???  -  the build failed: see the last line below          \n`);
		process.stdout.write(`  ${state.lastLine}\n`);
		return true;
	}

	const percentage = percentageFor(index, startedAt, now);
	const elapsed = (now - startedAt) / 1000;
	const remaining = percentage > 2 ? (elapsed / percentage) * (100 - percentage) : undefined;
	const line = `\r  ${bar(percentage)} ${String(Math.round(percentage)).padStart(3)}%  -  ${STAGES[index].label}  -  ${clock(elapsed)}` +
		(remaining === undefined ? '' : `, about ${clock(remaining)}`) + '   ';

	if (line !== lastDrawn) {
		lastDrawn = line;
		process.stdout.write(line);
	}
	return false;
}

if (args.includes('--stages')) {
	// Just the steps, for an interface that wants to show what the build is going to do before it has
	// ever run. One source of truth: the window does not carry its own copy of this list.
	process.stdout.write(JSON.stringify(STAGES.map(stage => ({ label: stage.label, detail: stage.detail }))) + '\n');
	process.exit(0);
}

if (asJson) {
	// One object, for a caller that draws its own interface: the window asks every second.
	const verdict = readVerdict();
	// A stale log - the verdict came from a newer build that wrote no live log - must not lend its
	// stages or its clock to this verdict. The verdict alone is what is true.
	if (verdict !== undefined && logIsStale()) {
		process.stdout.write(JSON.stringify({
			percentage: verdict === 'ok' ? 100 : 0,
			stage: '',
			stageDetail: '',
			stageIndex: -1,
			stages: STAGES.map(stage => ({ label: stage.label, detail: stage.detail })),
			elapsedSeconds: 0,
			remainingSeconds: 0,
			done: verdict,
			lastLine: '',
		}) + '\n');
		process.exit(0);
	}

	const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
	const state = readLog(text);
	if (state.done === undefined && verdict !== undefined) { state.done = verdict; }
	const now = Date.now();
	const index = state.index ?? 1;
	const percentage = state.done === 'ok' ? 100 : percentageFor(index, startedAt, now);
	const elapsed = (now - startedAt) / 1000;
	process.stdout.write(JSON.stringify({
		percentage: Math.round(percentage * 10) / 10,
		stage: STAGES[index].label,
		stageDetail: STAGES[index].detail,
		stageIndex: index,
		stages: STAGES.map(stage => ({ label: stage.label, detail: stage.detail })),
		elapsedSeconds: Math.round(elapsed),
		remainingSeconds: state.done === undefined && percentage > 2 ? Math.round((elapsed / percentage) * (100 - percentage)) : 0,
		done: state.done ?? null,
		lastLine: state.lastLine.replace(/\u001b\[[0-9;]*m/g, '').trim(),
	}) + '\n');
	process.exit(0);
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
