#!/usr/bin/env node
/*
 * dev -- the edit-and-look loop, in one command.
 *
 * Starts the watcher (it recompiles what you change, as you save) and opens the editor from `out/`.
 * That is not the pack: no copying, no staging, no installer -- the window runs the code in the
 * tree, so a change is visible after a reload (`Ctrl+R`), not after a build.
 *
 * What it does not show: anything the pack adds around the editor (the pi runtime, the durable
 * agent, the channel seal). Those need `build/build.sh` or the incremental pack; this is for
 * editing the editor itself. When a pack exists, its pi and durable agent are linked into
 * `resources/` so the chat works while editing.
 *
 * The first run downloads Electron into `.build/electron` (~100 MB) and the built-in extensions;
 * `scripts/code.bat` does that itself, and only once.
 *
 * Usage:
 *   npm run dev                 the loop, with a compact log
 *   npm run dev -- --verbose    the same, with every line the tools print
 *   npm run dev -- <args>       arguments go to the editor
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';

const CLI = process.argv.slice(2);
const VERBOSE = CLI.includes('--verbose') || CLI.includes('-v');
// DevTools on launch, because that is what the loop is for. `--no-devtools` keeps them closed for
// a run that should look like the real product.
const NO_DEVTOOLS = CLI.includes('--no-devtools');
const EDITOR_ARGS = [
	...CLI.filter(argument => !['--verbose', '-v', '--no-devtools'].includes(argument)),
	// A documented switch of the product itself (src/vs/platform/windows/electron-main/windowImpl.ts).
	...(NO_DEVTOOLS ? [] : ['--open-devtools']),
];

// What the pack adds around the editor, and where the editor looks for it in a source tree:
// `distributionRoot` is the repository root here, so `resources/pi-runtime` and
// `resources/durable` are the two paths the connector resolves. The pack already has both, built
// and pruned; linking them is what makes the chat and the agent work while editing, without
// copying 116 MB into the tree or teaching the connector a second layout.
const LINKED = ['pi-runtime', 'durable', 'durable-bridge'];

function packRoot() {
	for (const name of ['PiCode-Win32-x64', 'PiCode-Win32-x64-experimental', 'PiCode-Win32-x64-beta']) {
		const candidate = path.join(REPO, name);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function linkPackedRuntime() {
	const pack = packRoot();
	if (pack === undefined) {
		say('warn', 'no pack here yet, so the chat has no pi to run');
		say('note', 'npm run build:fast once, and this window gets the packed runtime');
		return;
	}
	const linked = [];
	for (const name of LINKED) {
		const target = path.join(pack, 'resources', name);
		const link = path.join(REPO, 'resources', name);
		if (!existsSync(target) || existsSync(link)) {
			continue;
		}
		try {
			// A junction on Windows and a plain symlink elsewhere; both are ignored by git.
			symlinkSync(target, link, isWindows ? 'junction' : 'dir');
			linked.push(name);
		} catch (error) {
			say('warn', `could not link resources/${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (linked.length > 0) {
		say('note', `pi and the agent come from ${path.basename(pack)}`);
	}
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------
// The tools underneath are talkative: npm prints seven warnings about its own config, gulp
// narrates every extension it cleans, and the transpiler lists what it copies. In a loop you run
// all day, that buries the two lines that matter -- "it compiled" and "it failed, here".
//
// So the stream is read line by line and only the meaningful lines survive: a milestone, a
// compilation result, or an error. `--verbose` turns the filter off.
const ANSI = /\u001b\[[0-9;]*m/g;
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = text => paint('2', text);
const red = text => paint('31', text);
const yellow = text => paint('33', text);
const green = text => paint('32', text);
const cyan = text => paint('36', text);

const GLYPH = { ok: '✔', fail: '✖', warn: '!', note: '·' };

/** One line of our own, in the same shape as the tool lines. */
function say(kind, message) {
	const glyph = GLYPH[kind] ?? '·';
	const colour = kind === 'fail' ? red : kind === 'warn' ? yellow : kind === 'ok' ? green : cyan;
	process.stdout.write(`${colour(glyph)} ${message}\n`);
}

/** Lines whose only content is noise from the tools underneath. */
const NOISE = [
	/^npm (warn|notice|ERR)/,
	/^> code-oss-dev@/,
	/^> npm run /,
	/^> node (build|--experimental)/,
	/^Using gulpfile/,
	/^You can manage built-in extensions/,
	/^Synchronizing built-in extensions/,
	/^\[marketplace\]/,
	/^clean-extension-/,
	/^Starting watch-extension/,
	/^Finished clean-extension/,
	/^Starting transpilation/,
	/^\[transpile\] (Found|src →)/,
	/^\[resources\] (Copying|Copied)/,
	/^\[watch\] Copied /,
	/^Starting compilation/,
	/^Starting (watch-api-proposal-names|watch-extension-point-names|watch-codicons)/,
	/^Starting 'watch/,
	/^Finished 'watch/,
];

/** `Finished compilation X with 0 errors after 2100 ms` and its relatives. */
const COMPILED = /^Finished (compilation|transpilation)(?:\s+\S+)?\s+with (\d+) errors?(?: \([^)]*\))?(?: after ([\d.]+) ms)?/;

/** A line that deserves to be seen: errors, failures, a crash. */
function isFailure(text) {
	if (/with 0 errors/.test(text)) {
		return false;
	}
	return /\b(error|errors|failed|failure|exception|ENOENT|cannot find|not found)\b/i.test(text);
}

/** Turns one tool line into what the loop shows, or nothing. */
function present(line) {
	const stripped = line.replace(ANSI, '').trim();
	if (stripped === '') {
		return;
	}
	// `[watch-client          ] message` -- the tag names the tool, the rest is the message.
	const tagged = /^\[([a-z-]+)\s*\]\s?(.*)$/.exec(stripped);
	const message = (tagged?.[2] ?? stripped).trim();
	if (message === '') {
		return;
	}

	const compiled = COMPILED.exec(message);
	if (compiled !== null) {
		const [, what, errors, milliseconds] = compiled;
		const seconds = milliseconds === undefined ? 0 : Number(milliseconds) / 1000;
		// The watcher also fires for a single copied file (a codicon, a stylesheet). That is not a
		// compile worth a line; a real one takes longer than a fifth of a second.
		if (Number(errors) === 0 && what === 'transpilation' && seconds < 0.2) {
			return;
		}
		const timing = seconds === 0 ? '' : ` in ${seconds.toFixed(1)} s`;
		if (Number(errors) === 0) {
			say('ok', `${what === 'transpilation' ? 'transpiled' : 'compiled'}${timing}`);
		} else {
			say('fail', `${what} failed with ${errors} error${Number(errors) === 1 ? '' : 's'}${timing}`);
		}
		return;
	}

	if (/^\[watch\] Watching src/.test(message)) {
		say('ok', 'watching -- save a file, then Ctrl+R in the editor');
		return;
	}

	if (isFailure(message)) {
		say('fail', tagged === null ? message : `${message} ${dim(`(${tagged[1]})`)}`);
		return;
	}

	if (NOISE.some(pattern => pattern.test(message))) {
		return;
	}

	// Everything else is shown quietly, so a line nobody classified still reaches the reader.
	if (VERBOSE) {
		process.stdout.write(`${dim('·')} ${dim(message)}\n`);
	}
}

/** Reads a stream by line, whatever the chunk boundaries are. */
function reporter(stream, sink = process.stdout) {
	let buffer = '';
	return {
		write(chunk) {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (VERBOSE) {
					sink.write(`${line}\n`);
				} else {
					present(line);
				}
			}
		},
	};
}

/**
 * The editor is chattier still: every extension host message, every Chromium INFO:CONSOLE line,
 * and one crashpad warning nobody can act on. What is worth a line is a real failure, so this
 * keeps those and drops the rest.
 */
const EDITOR_FAILURE = /(\bERROR\b|\[error\]|\bexception\b|\bUncaught\b|\bFailed\b|\bfailed\b|\bENOENT\b|\bcannot find\b|\bWarning\b: .*deprecat)/i;
const EDITOR_NOISE = /(INFO:CONSOLE|Google API|DevTools listening|dbus|GPU|Vulkan|ANGLE|Swiftshader|registration_protocol)/i;

function editorReporter(sink = process.stdout) {
	let buffer = '';
	return {
		write(chunk) {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const raw of lines) {
				const line = raw.replace(ANSI, '').trim();
				if (line === '') {
					continue;
				}
				if (VERBOSE) {
					sink.write(`${raw}\n`);
					continue;
				}
				if (EDITOR_NOISE.test(line) || !EDITOR_FAILURE.test(line)) {
					continue;
				}
				say('fail', line);
			}
		},
	};
}

/**
 * The line the transpiler prints once `out/` is complete.
 *
 * Waiting for the file to exist is not enough: the transpiler starts by deleting `out/`, so on a
 * second run the file is there from the run before, the editor opens, and the delete lands
 * underneath it -- which is exactly the `ERR_FILE_NOT_FOUND` that made the window come up empty.
 * This marker comes after the clean and after every file has been written.
 */
export const TRANSPILED = /\[watch\] Watching src/;

/** Waits for the watcher to finish transpiling, showing its lines as they arrive. */
function waitForTranspile(child, timeoutMs = 10 * 60 * 1000) {
	return new Promise(resolve => {
		let seen = '';
		let done = false;
		const finish = ok => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(ok);
			}
		};
		const onData = chunk => {
			if (!done) {
				// A line can be split across chunks; keeping a tail makes the match survive that.
				seen = (seen + chunk.toString()).slice(-4096);
				if (TRANSPILED.test(seen)) {
					finish(true);
				}
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('exit', () => finish(false));
		const timer = setTimeout(() => finish(false), timeoutMs);
	});
}

let watch;
let launched;
let lockFile;

/**
 * One dev session at a time.
 *
 * Two watchers both delete and rewrite `out/` (the transpiler cleans it on start), so the second
 * one pulls the floor out from under the editor the first one opened. The lock is a pid file, the
 * same shape `build-run.sh` uses for the build: a stale pid is removed, a live one refuses.
 */
function takeLock() {
	lockFile = path.join(REPO, '.scratch', 'dev.lock');
	try {
		const pid = Number(readFileSync(lockFile, 'utf8').trim());
		if (Number.isInteger(pid) && pid > 0) {
			try {
				process.kill(pid, 0);
				return pid;
			} catch {
				// The process is gone: the lock is from a session that was killed.
			}
		}
	} catch {
		// No lock yet.
	}
	mkdirSync(path.dirname(lockFile), { recursive: true });
	writeFileSync(lockFile, `${process.pid}\n`);
	return undefined;
}

function stop(code) {
	if (launched !== undefined) {
		launched.kill();
	}
	if (watch !== undefined) {
		watch.kill();
	}
	if (lockFile !== undefined) {
		try {
			unlinkSync(lockFile);
		} catch {
			// Already gone.
		}
	}
	process.exit(code);
}

// Only when run as a command: importing this file (a check, a test) must not start a watcher.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const running = takeLock();
	if (running !== undefined) {
		say('fail', `another dev session is already running (pid ${running})`);
		say('note', 'close that editor (its terminal then exits), or stop that terminal');
		process.exit(3);
	}

	process.on('SIGINT', () => stop(0));
	process.on('SIGTERM', () => stop(0));

	if (!VERBOSE) {
		process.stdout.write(`\n  ${paint('1', 'PiCode dev')}  ${dim('save a file, then Ctrl+R in the editor')}\n`);
		process.stdout.write(`  ${dim('npm run dev -- --verbose shows every line')}\n\n`);
	}

	linkPackedRuntime();

	watch = spawn(
		isWindows ? 'cmd.exe' : 'bash',
		isWindows ? ['/d', '/s', '/c', 'npm run watch'] : ['-c', 'npm run watch'],
		{
			cwd: REPO,
			stdio: ['ignore', 'pipe', 'pipe'],
			// The project's .npmrc carries keys from VS Code's own scripts; npm warns about each one
			// on every invocation, and in this loop that is seven lines of noise per process.
			env: { ...process.env, npm_config_loglevel: 'error' },
		}
	);

	const out = reporter(watch.stdout, process.stdout);
	const err = reporter(watch.stderr, process.stderr);
	watch.stdout?.on('data', chunk => out.write(chunk));
	// The readiness check reads the same stream; both are attached on purpose, one filters and one
	// only looks for the marker.
	watch.stderr?.on('data', chunk => err.write(chunk));

	say('note', 'compiling (the editor opens when out/ is complete)');

	if (!(await waitForTranspile(watch))) {
		say('fail', 'the watcher did not finish transpiling in ten minutes; stopping');
		stop(1);
	}

	say('note', 'opening the editor (the first run also fetches Electron)');
	const openedAt = Date.now();
	launched = isWindows
		? spawn('cmd.exe', ['/c', 'scripts\\code.bat', ...EDITOR_ARGS], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VSCODE_OPEN_DEVTOOLS: NO_DEVTOOLS ? '0' : '1' } })
		: spawn('bash', ['scripts/code.sh', ...EDITOR_ARGS], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VSCODE_OPEN_DEVTOOLS: NO_DEVTOOLS ? '0' : '1' } });

	const editorOut = editorReporter(process.stdout);
	const editorErr = editorReporter(process.stderr);
	launched.stdout?.on('data', chunk => editorOut.write(chunk));
	launched.stderr?.on('data', chunk => editorErr.write(chunk));

	launched.on('exit', code => {
		// An editor that is already open takes over the launch and this one exits at once, with 0.
		// Killing the watcher then would leave that window with no recompiles, so the session stays
		// up and says what happened; Ctrl+C stops it.
		if (Date.now() - openedAt < 3000) {
			say('warn', 'the editor exited immediately -- a PiCode dev window may already be open');
			say('note', 'the watcher is still running; Ctrl+C stops it');
			return;
		}
		say('note', 'the editor closed');
		stop(code ?? 0);
	});
}