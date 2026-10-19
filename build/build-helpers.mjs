#!/usr/bin/env node
/*
 * build-helpers -- the build asking the tree what it needs.
 *
 * Where the packed editor is, whether the installed dependencies still match the
 * source, what a machine needs before a build will run, what a build already in
 * flight is doing, and putting the owner's profile back after a pack that deletes it.
 *
 * Usage:
 *   node build/build-helpers.mjs progress
 *   node build/build-helpers.mjs requirements
 *   node build/build-helpers.mjs deps-current
 *   node build/build-helpers.mjs pack-dir
 *   node build/build-helpers.mjs restore-profile
 *
 * One file per domain: the scripts that used to sit side by side in build/ were fused
 * here, each keeping its own explanation directly above the code it runs. Commands are
 * functions, so this file can also be imported (build/checks.mjs imports resolvePack)
 * without anything running.
 */

import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

/**
 * The packed editor beside the repository: the channel's folder when there is one, the plain
 * `PiCode-win32-x64` otherwise.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolvePack(repoRoot) {
	const candidates = fs
		.readdirSync(repoRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && /^picode-win32-x64/i.test(entry.name))
		.map(entry => path.join(repoRoot, entry.name))
		.sort();
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, 'resources', 'pi-runtime'))) {
			return dir;
		}
	}
	return candidates[0] ?? path.join(repoRoot, 'PiCode-win32-x64');
}

	// progress -- was build/build-progress.mjs
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
	 * Usage: node build/build-helpers.mjs progress [log file] [--once]
	 *   log file   defaults to the newest `.scratch/build*.log`
	 *   --once     print one line and exit, for a caller that wants a snapshot
	 */
	async function cmdProgress(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const REPO = path.resolve(import.meta.dirname, '..');

	// The channel names the pack folder (PiCode-win32-x64, plus -beta or -experimental), and it may
	// not exist yet when the watching starts, so it is resolved the first time the bar needs it.
	let PACK = null;
	const packDir = () => (PACK ??= resolvePack(REPO));
	const NODE_MODULES = path.join(REPO, 'node_modules');

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

	const args = cli;
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

	/**
	 * The build's own event stream (`.scratch/build.jsonl`), when there is one.
	 *
	 * The log says where the build is; the events say **when** it got there. Without them the bar
	 * had to guess a stage's start from the log file's birth time and ramp from the beginning of
	 * the build, which made a late stage run its ramp too fast. The event file is appended by
	 * `build.sh` as each phase starts and ends, so it survives a crash and needs no parsing.
	 *
	 * Absent (a build from before the events existed, or one that died before writing) is normal:
	 * every caller falls back to the log.
	 */
	function readEvents() {
		try {
			const file = path.join(REPO, '.scratch', 'build.jsonl');
			const events = fs.readFileSync(file, 'utf8')
				.split('\n')
				.filter(line => line.trim().length > 0)
				.map(line => {
					try { return JSON.parse(line); } catch { return undefined; }
				})
				.filter(event => event !== undefined);
			if (events.length === 0) { return undefined; }
			const starts = new Map();
			let current;
			let end;
			for (const event of events) {
				if (event.event === 'phase-start') {
					starts.set(event.phase, Date.parse(event.at));
					current = event;
				} else if (event.event === 'phase-end') {
					// The phase has finished: the next start moves `current` on, and the bar can sit
					// at this phase's top until then.
					starts.set(event.phase, starts.get(event.phase) ?? Date.parse(event.at));
				} else if (event.event === 'end') {
					end = event;
				}
			}
			return { events, starts, current, end, startedAt: Date.parse(events[0].at) };
		} catch {
			return undefined;
		}
	}

	/** The build phase each bar stage belongs to. The dependencies stage is inside phase 1. */
	const PHASE_FOR_STAGE = [1, 1, 2, 3, 4, 5];

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
			const out = path.join(packDir(), 'resources', 'app', 'out');
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

	/**
	 * The percentage of the whole, from the stage and how far inside it the build is.
	 *
	 * `stageStartedAt` is when **this stage** started (from the event stream) and not when the build
	 * started: the ramp is "how long this has been going", not "how long the build has".
	 */
	function percentageFor(index, stageStartedAt, now) {
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
		const elapsed = (now - stageStartedAt) / 1000;
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
	 * build/build.sh writes a verdict but no live log, so the log on disk can be the previous run's - and
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
			const raw = fs.readFileSync(path.join(REPO, '.scratch', 'build.status'), 'utf8').trim();
			if (raw === '') { return undefined; }
			// A bare exit code, from a build that ran before the status became JSON. A status left on
			// disk by an older build must not read as a corrupt one.
			if (/^\d+$/.test(raw)) { return raw === '0' ? 'ok' : 'failed'; }
			const status = JSON.parse(raw);
			return status.outcome === 'ok' ? 'ok' : 'failed';
		} catch {
			return undefined;
		}
	}

	/** The whole status object, when it is one: the phase it died in, how long it ran, its channel. */
	function readStatus() {
		try {
			const raw = fs.readFileSync(path.join(REPO, '.scratch', 'build.status'), 'utf8').trim();
			if (raw === '' || /^\d+$/.test(raw)) { return undefined; }
			return JSON.parse(raw);
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
				process.stdout.write(`\r  done   ${bar(100)} 100%  -  the build finished, in ${path.basename(packDir())}          \n`);
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
			process.stdout.write(`\r  done   ${bar(100)} 100%  -  the build finished, in ${path.basename(packDir())}          \n`);
			return true;
		}
		if (state.done === 'failed') {
			process.stdout.write(`\r  failed ${bar(100)} ???  -  the build failed: see the last line below          \n`);
			process.stdout.write(`  ${state.lastLine}\n`);
			return true;
		}

		// When the build and this stage actually started, from its own events; the log's age when
		// there is no event stream to ask.
		const events = readEvents();
		const buildStartedAt = events?.startedAt ?? startedAt;
		const stageStartedAt = events?.starts?.get(PHASE_FOR_STAGE[index]) ?? buildStartedAt;
		const percentage = percentageFor(index, stageStartedAt, now);
		const elapsed = (now - buildStartedAt) / 1000;
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
				phaseName: readStatus()?.phaseName ?? '',
				exitCode: readStatus()?.exitCode ?? (verdict === 'ok' ? 0 : null),
				lastLine: '',
			}) + '\n');
			process.exit(0);
		}

		const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
		const state = readLog(text);
		if (state.done === undefined && verdict !== undefined) { state.done = verdict; }
		const now = Date.now();
		const index = state.index ?? 1;
		const events = readEvents();
		const buildStartedAt = events?.startedAt ?? startedAt;
		const stageStartedAt = events?.starts?.get(PHASE_FOR_STAGE[index]) ?? buildStartedAt;
		const percentage = state.done === 'ok' ? 100 : percentageFor(index, stageStartedAt, now);
		const elapsed = (now - buildStartedAt) / 1000;
		process.stdout.write(JSON.stringify({
			percentage: Math.round(percentage * 10) / 10,
			stage: STAGES[index].label,
			stageDetail: STAGES[index].detail,
			stageIndex: index,
			stages: STAGES.map(stage => ({ label: stage.label, detail: stage.detail })),
			elapsedSeconds: Math.round(elapsed),
			remainingSeconds: state.done === undefined && percentage > 2 ? Math.round((elapsed / percentage) * (100 - percentage)) : 0,
			done: state.done ?? null,
			// Which phase it died in, and its exact exit code, when the build left a JSON status.
			phaseName: readStatus()?.phaseName ?? '',
			exitCode: readStatus()?.exitCode ?? (state.done === 'ok' ? 0 : null),
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
			process.stdout.write(`\n  could not read the log: ${error instanceof Error ? error.message : String(error)}\n`);
			ended = true;
		}
		if (ended) {
			clearInterval(timer);
		}
	}, 1000);
	}

	// requirements -- was build/build-requirements.mjs
	/*
	 * What the build needs, in one place.
	 *
	 * Two front-ends ask this question — the PowerShell window and the C# builder — and a third (the
	 * terminal) may want it later. Each one used to work it out on its own, which is two copies of the
	 * same truth and one of them always ends up stale. This is that truth: the checks, what each one is
	 * for, and how to get it.
	 *
	 * Usage: node build/build-helpers.mjs requirements [--json]
	 *
	 *   --json   one object: the platform, whether anything blocks a build, and one entry per check with
	 *            its name, whether it is there, what was found, and how to install it.
	 *   (plain)  one line per check, for a person in a terminal.
	 *
	 * Platform matters: a check about the editor being closed is about Windows, where the build replaces
	 * a folder Windows will not let go of while a program is running. On Linux it is not asked.
	 */
	async function cmdRequirements(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const { execFileSync } = await import('node:child_process');
	const bs = String.fromCharCode(92);

	// On Windows, the builder is often launched from Explorer, whose PATH does not include Git's
	// directories even when Git for Windows is installed. Augment PATH with the common locations
	// so the checks below can actually find git and bash instead of reporting them missing.
	if (process.platform === 'win32') {
		const candidates = [
			path.join(process.env['ProgramFiles'] ?? `C:${bs}Program Files`, 'Git', 'cmd'),
			path.join(process.env['ProgramFiles'] ?? `C:${bs}Program Files`, 'Git', 'bin'),
			path.join(process.env['ProgramFiles'] ?? `C:${bs}Program Files`, 'Git', 'usr', 'bin'),
			path.join(process.env['ProgramFiles(x86)'] ?? `C:${bs}Program Files (x86)`, 'Git', 'cmd'),
			path.join(process.env['ProgramFiles(x86)'] ?? `C:${bs}Program Files (x86)`, 'Git', 'bin'),
			path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'cmd'),
			path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin'),
		];
		const current = (process.env.PATH ?? '').split(path.delimiter);
		for (const dir of candidates) {
			if (dir && fs.existsSync(dir) && !current.includes(dir)) {
				current.unshift(dir);
			}
		}
		process.env.PATH = current.join(path.delimiter);
	}

	const REPO = path.resolve(import.meta.dirname, '..');
	const json = cli.includes('--json');

	const isWindows = process.platform === 'win32';

	/** What a command prints, or nothing at all: every check here can fail without stopping anything. */
	function run(command, args) {
		try {
			return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
		} catch {
			return '';
		}
	}

	/** The node the build wants, from `.nvmrc`: the pin, not whatever happens to be installed. */
	function wantedNode() {
		try {
			return fs.readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim().split('.')[0];
		} catch {
			return '24';
		}
	}

	function roomOnDisk() {
		try {
			const stat = fs.statfsSync(REPO);
			return Math.round((stat.bavail * stat.bsize) / 1024 / 1024 / 1024 * 10) / 10;
		} catch {
			return undefined;
		}
	}

	const checks = [];

	// Node runs the build's own tasks. The major version is what matters: any 24.x will do.
	const nodeVersion = run(process.execPath, ['--version']).replace(/^v/, '');
	const wanted = wantedNode();
	// What to say when node is not the one the build wants. Linux installs it with nvm, and the pin in
	// .nvmrc is what matters there.
	let nodeMissing = `Node.js ${wanted} is what the build uses; this machine has v${nodeVersion}`;
	if (nodeVersion === '') {
		nodeMissing = `Node.js ${wanted} is missing (on Linux install it with nvm, following .nvmrc)`;
	}

	checks.push({
		id: 'node',
		icon: 'nodedotjs',
		name: 'Node.js',
		ok: nodeVersion !== '' && nodeVersion.split('.')[0] === wanted,
		found: nodeVersion === '' ? 'not found' : `v${nodeVersion} (the build wants ${wanted})`,
			missing: nodeMissing,
		install: 'OpenJS.NodeJS',
		url: 'https://nodejs.org/en/download',
		note: 'runs npm and the build tasks'
	});

	// Git and Git Bash are one install on Windows, so they are one check: the Bash is what runs the build.
	function findGit() {
		if (run('git', ['--version']) !== '') return 'git';
		// Search common install locations when PATH does not include them.
		const roots = [
			process.env['ProgramFiles'] ?? `C:${bs}Program Files`,
			process.env['ProgramFiles(x86)'] ?? `C:${bs}Program Files (x86)`,
			process.env['LOCALAPPDATA'] ?? '',
		];
		for (const root of roots) {
			if (!root) continue;
			for (const sub of ['Git\\cmd\\git.exe', 'Git\\bin\\git.exe', 'Programs\\Git\\cmd\\git.exe']) {
				const p = path.join(root, sub);
				if (fs.existsSync(p)) return p;
			}
		}
		return '';
	}

	const gitCmd = findGit();
	const git = gitCmd === '' ? '' : run(gitCmd, ['--version']);
	function findBash() {
		if (run('bash', ['-c', 'echo yes']) === 'yes') return 'bash';
		const roots = [
			process.env['ProgramFiles'] ?? `C:${bs}Program Files`,
			process.env['ProgramFiles(x86)'] ?? `C:${bs}Program Files (x86)`,
			process.env['LOCALAPPDATA'] ?? '',
		];
		for (const root of roots) {
			if (!root) continue;
			for (const sub of ['Git\\bin\\bash.exe', 'Git\\usr\\bin\\bash.exe', 'Programs\\Git\\bin\\bash.exe']) {
				const p = path.join(root, sub);
				if (fs.existsSync(p)) return p;
			}
		}
		return '';
	}

	const bashCmd = findBash();
	const hasBash = bashCmd !== '' && run(bashCmd, ['-c', 'echo yes']) === 'yes';
	let shellNote = ', with no shell';
	if (hasBash) {
		shellNote = isWindows ? ', with Git Bash' : ', with a shell';
	}
	checks.push({
		id: 'git',
		icon: 'git',
		name: isWindows ? 'Git for Windows' : 'Git and a shell',
		ok: git !== '' && hasBash,
		found: git === '' ? 'not found' : `${git}${shellNote}`,
		missing: git === '' ? 'Git is missing' : 'No shell to run the build in',
		install: 'Git.Git',
		url: 'https://git-scm.com/downloads',
		note: 'Git, and the shell the build runs in'
	});

	const python = run('python3', ['--version']) || run('python', ['--version']);
	checks.push({
		id: 'python',
		icon: 'python',
		name: 'Python 3',
		ok: python !== '',
		found: python === '' ? 'not found' : python,
		missing: isWindows ? 'Python 3 is missing' : 'Python 3 is missing. Install with: sudo apt install -y python3',
		install: isWindows ? 'Python.Python.3.12' : '',
		url: 'https://www.python.org/downloads/',
		note: 'the native modules are compiled with it'
	});

	// The C++ toolchain, which is what compiles the native modules the editor needs. On Windows that is
	// Visual Studio, and specifically its Spectre-mitigated libraries: without them the build stops with
	// MSB8040, minutes in, which is the failure this check exists to move to the front.
	if (isWindows) {
		let vs = '';
		let spectre = '';
		let cpp = '';
		const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:' + bs + 'Program Files (x86)',
			'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
		if (fs.existsSync(vswhere)) {
			vs = run(vswhere, ['-latest', '-products', '*', '-property', 'installationPath']);
			cpp = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
			spectre = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre', '-property', 'installationPath']);
		}
		const complete = vs !== '' && cpp !== '' && spectre !== '';
		let found = 'the C++ tools and the Spectre libraries are there';
		if (vs === '') { found = 'Visual Studio was not found'; }
		else if (cpp === '') { found = 'the C++ tools are missing'; }
		else if (spectre === '') { found = 'the Spectre libraries are missing'; }
		let missing = 'The Spectre-mitigated libraries are missing: the build stops with MSB8040 without them';
		if (vs === '') { missing = 'Visual Studio 2022 with Desktop development with C++ is missing'; }
		else if (cpp === '') { missing = 'Visual Studio is there but without the C++ tools'; }
		checks.push({
			id: 'cplusplus',
			name: 'Visual Studio, C++ and Spectre',
			ok: complete,
			found,
			missing,
			install: '',
			url: 'https://learn.microsoft.com/cpp/build/reference/vs2022-redistributable-and-spectre-libraries',
			note: 'node-gyp compiles the native modules with MSBuild'
		});
	} else {
		const gcc = run('g++', ['--version']) || run('clang++', ['--version']);
		const make = run('make', ['--version']);
		let found = `${gcc} and ${make}`;
		if (gcc === '') { found = 'not found'; }
		else if (make === '') { found = `${gcc}, but make is missing`; }

		// The editor's native modules link against X11, keymap, libsecret and krb5: without these headers
		// the compile stops in npm ci, minutes in. dpkg says what is installed; on a distribution without
		// dpkg the check says it could not look instead of guessing.
		const libraries = ['libx11-dev', 'libxkbfile-dev', 'libsecret-1-dev', 'libkrb5-dev'];
		const hasDpkg = run('dpkg', ['--version']) !== '';
		const missingLibs = hasDpkg
			? libraries.filter(name => run('dpkg', ['-s', name]) === '')
			: [];
		const libsOk = hasDpkg && missingLibs.length === 0;
		let libsFound = libraries.join(', ');
		if (!hasDpkg) { libsFound = 'could not be checked (no dpkg on this distribution)'; }
		else if (missingLibs.length > 0) { libsFound = `missing: ${missingLibs.join(', ')}`; }

		const aptLibs = ['build-essential', ...libraries].join(' ');
		const aptCommand = `sudo apt install -y ${aptLibs}`;

		checks.push({
			id: 'cplusplus',
			name: 'A C++ compiler and make',
			ok: gcc !== '' && make !== '',
			found,
			missing: `Compiling needs both. Install with: ${aptCommand}`,
			install: '',
			url: '',
			note: 'node-gyp compiles the native modules with them'
		});

		checks.push({
			id: 'native-headers',
			name: 'Native module headers',
			optional: !hasDpkg,
			ok: libsOk,
			found: libsFound,
			missing: `Missing: ${missingLibs.join(', ')}. Install with: ${aptCommand}`,
			install: '',
			url: '',
			note: 'the editor\u2019s native modules link against X11, keymap, libsecret and krb5'
		});
	}

	// Rust builds some of the editor's native modules. Recommended, not required: the pipeline does not ask
	// for it, so a machine without it may well build, and refusing to try would be the wrong call.
	const cargo = run('cargo', ['--version']);
	checks.push({
		id: 'rust',
		icon: 'rust',
		name: 'Rust',
		optional: true,
		ok: cargo !== '',
		found: cargo === '' ? 'not found' : cargo,
		missing: 'Rust is not installed (recommended, not required)',
		install: 'Rustlang.Rustup',
		url: 'https://rustup.rs/',
		note: 'compiles some of the native modules; it rewrites PATH, so restart the shell afterwards'
	});

	const free = roomOnDisk();
	checks.push({
		id: 'disk',
		name: 'Room on disk',
		ok: free === undefined ? false : free >= 8,
		found: free === undefined ? 'could not be read' : `${free} GB free`,
		missing: free === undefined ? 'The free space could not be read' : `Only ${free} GB free: the build needs about 8 GB`,
		install: '',
		url: '',
		note: 'the source, its dependencies and the packed editor take a few GB'
	});

	// Windows only, and not a tool: the one thing that has to be true for the pack to be able to replace
	// the folder the editor runs from.
	if (isWindows) {
		let running = false;
		try {
			const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PiCode*', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			// Count PiCode processes that are NOT the builder itself.
			running = out.split(/\r?\n/).some(line => /PiCode/i.test(line) && !/Builder/i.test(line));
		} catch {
			running = false;
		}
		checks.push({
			id: 'editor-closed',
			icon: 'picode',
			name: 'PiCode closed',
			ok: !running,
			found: running ? 'PiCode is running' : 'nothing is using the folder it is built into',
			missing: 'Close PiCode first: the build replaces the folder the editor runs from',
			install: '',
			url: '',
			note: 'Windows will not delete the files of a program that is running'
		});
	}

	// Required, or merely recommended. The difference matters: something recommended that is missing must
	// not stop a build that would have worked, and the pipeline itself decides that - it demands only
	// git and node (jq left the pipeline with the patch machinery), and the rest is what installing
	// the dependencies needs.
	const blockers = checks.filter(check => !check.ok && !check.optional);

	if (json) {
		process.stdout.write(JSON.stringify({
			platform: isWindows ? 'windows' : 'linux',
			ready: blockers.length === 0,
			required: checks.filter(check => !check.optional).length,
			blockers: blockers.map(check => check.id),
			checks
		}, null, '\t') + '\n');
	} else {
		for (const check of checks) {
			// The mark: fine, only recommended and missing, or missing.
			let mark = 'OK  ';
			if (!check.ok) { mark = check.optional ? '--  ' : 'NO  '; }
			process.stdout.write(`${mark}${(check.optional ? check.name + ' (rec.)' : check.name).padEnd(32)} ${check.ok ? check.found : check.missing}\n`);
		}
		process.stdout.write(blockers.length === 0 ? 'nothing is missing\n' : `${blockers.length} thing(s) to fix\n`);
	}
	}

	// deps-current -- was build/deps-current.mjs
	/*
	 * Are the installed dependencies still the ones this source needs?
	 *
	 * `npm ci` used to run on every build, and that is the step this answers. VS Code records the
	 * dependency state it installed in `node_modules/.postinstall-state`, and
	 * `build/npm/installStateHash.ts` compares that record against the tree as it is now, by
	 * content hash, over package.json, package-lock.json and .npmrc for the root and for every
	 * nested project the build installs.
	 *
	 * The answer this prints is used only to SKIP the install, and only when the two sides are
	 * identical. Anything else - no record, a different node, an unreadable state - is a no, and
	 * the install runs. The fast path this replaced trusted a half-built tree and was removed
	 * from the CI workflow on 2026-09-27 for exactly that reason; being slow is not a reason to
	 * be wrong about it.
	 *
	 * Run from the source tree: the working directory is the tree root.
	 *
	 *   exit 0  the record matches this tree: nothing to install
	 *   exit 1  it does not, or it could not be read: the install has to run
	 *
	 * One case is worth knowing about: writing a new release version into package.json (which is
	 * what build/build.sh does when product.json's version moves) changes that
	 * file's hash, so the build right after a version bump reinstalls. The version cannot affect
	 * which packages are installed, but proving that would mean reimplementing VS Code's hash,
	 * and the build prefers to install once too often than to trust a tree it has not checked.
	 */
	async function cmdDepsCurrent(cli) {
	const { execFileSync } = await import('node:child_process');
	const fs = (await import('node:fs')).default;
	const path = (await import('node:path')).default;
	const tree = process.cwd();
	const hashScript = path.join(tree, 'build', 'npm', 'installStateHash.ts');

	function no(message) {
		console.error(`  ${message}`);
		process.exit(1);
	}

	if (!fs.existsSync(hashScript)) {
		no('build/npm/installStateHash.ts is missing, so the recorded dependency state cannot be read');
	}

	let output;
	try {
		output = execFileSync(process.execPath, [hashScript], {
			cwd: tree,
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'ignore' ]
		});
	} catch (error) {
		no('the recorded dependency state could not be computed; installing to be sure');
	}

	let state;
	try {
		state = JSON.parse(output);
	} catch (error) {
		no('the dependency state was not JSON; installing to be sure');
	}

	const saved = state.saved;
	const current = state.current;

	if (!saved || !current) {
		no('nothing is recorded for this tree; installing');
	}

	if (saved.nodeVersion !== current.nodeVersion) {
		no(`the record was made with node ${saved.nodeVersion} and this is node ${current.nodeVersion}; installing`);
	}

	// The two sides are objects of file name to hash. Serialising them in their own key order
	// would report a difference that is not there, so the keys are sorted before comparing.
	function canonical(value) {
		if (value === null || typeof value !== 'object') {
			return JSON.stringify(value);
		}
		if (Array.isArray(value)) {
			return `[${value.map(canonical).join(',')}]`;
		}
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}

	if (canonical(saved.fileHashes) !== canonical(current.fileHashes)) {
		const changed = Object.keys(current.fileHashes ?? {}).filter(
			key => (current.fileHashes ?? {})[key] !== (saved.fileHashes ?? {})[key]
		);
		no(
			changed.length > 0
				? `${changed.join(', ')} changed since the last install; installing`
				: 'the recorded dependency inputs changed since the last install; installing'
		);
	}

	// The hashes above prove the inputs have not changed; they say nothing about whether the
	// install is still on disk. The CI cache restores the root node_modules - which carries the
	// state file - without the nested projects' node_modules, so an unchanged tree with a missing
	// build/node_modules would otherwise read as "up to date" and the build would fail on the first
	// import that lives there (gulp-merge-json, for one). postinstall installs every dir in
	// build/npm/dirs.ts into its own node_modules, so require each recorded project to still have one.
	for (const key of Object.keys(current.fileHashes ?? {})) {
		if (path.basename(key) !== 'package.json') {
			continue;
		}
		const project = path.dirname(key);
		const nodeModules = path.join(tree, project === '.' ? '' : project, 'node_modules');
		if (!fs.existsSync(nodeModules)) {
			no(`the recorded install has no ${path.relative(tree, nodeModules)}; installing`);
		}
	}

	console.log(`  the recorded dependency state matches this tree (node ${current.nodeVersion})`);
	}

	// pack-dir -- was build/pack-dir.mjs
	/*
	 * Finds the packed editor when the caller does not name one.
	 *
	 * The packer (build/gulpfile.vscode.ts) names the folder `PiCode-<platform>-<arch>` plus the
	 * channel suffix `build.sh` appends: `PiCode-win32-x64` for stable, and `-beta` or
	 * `-experimental` for the other channels. A caller that assumes the plain name finds nothing
	 * under a channel build — that is exactly how CI broke, with `check-mcp-entries.mjs` looking
	 * for a folder the build had named after its channel.
	 *
	 * The match is case-insensitive because the platform segment is lower case on disk and a
	 * hand-named tree may not be, and a folder that carries the pinned pi runtime is preferred over
	 * one that does not (there can be more than one pack beside the repository).
	 *
	 * Run directly (`node build/build-helpers.mjs pack-dir`) and it prints the folder relative to the repository,
	 * which is how the CI workflow resolves it without repeating this rule in YAML.
	 */
	async function cmdPackDir(cli) {
		const pack = resolvePack(REPO);
		if (!fs.existsSync(pack)) {
			process.stderr.write('error: no packed folder found (build the editor first, node build/build-helpers.mjs).\n');
			process.exit(1);
		}
		// Relative to the repository, which is where the workflow runs it from. It exports the
		// result as `PACK`, and the job summary concatenates it onto `./` to read the built
		// product.json, so an absolute path would break there: a Windows drive path loses its
		// separators in that string.
		process.stdout.write(`${path.relative(REPO, pack)}\n`);
	}

	// restore-profile -- was build/restore-profile.mjs
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
	 * Usage: node build/build-helpers.mjs restore-profile [--pack <dir>]
	 */
	async function cmdRestoreProfile(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const REPO = path.resolve(import.meta.dirname, '..');
	const args = cli;
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
	}


const USAGE = `usage: node build/build-helpers.mjs <progress|requirements|deps-current|pack-dir|restore-profile>\n`;
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'progress':
			return cmdProgress(cli.slice(1));
		case 'requirements':
			return cmdRequirements(cli.slice(1));
		case 'deps-current':
			return cmdDepsCurrent(cli.slice(1));
		case 'pack-dir':
			return cmdPackDir(cli.slice(1));
		case 'restore-profile':
			return cmdRestoreProfile(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			return process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await dispatch();
}
