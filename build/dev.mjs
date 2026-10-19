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
 * editing the editor itself.
 *
 * The first run downloads Electron into `.build/electron` (~100 MB) and the built-in extensions;
 * `scripts/code.bat` does that itself, and only once.
 *
 * Usage: npm run dev [-- arguments for the editor]
 */
import { spawn } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

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
		console.log('dev: no pack here yet, so pi and the durable agent are unavailable in this window');
		console.log('dev: run "npm run build:fast" once if you want the chat to work while editing');
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
			console.log(`dev: could not link resources/${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (linked.length > 0) {
		console.log(`dev: using the packed ${linked.join(', ')} (linked from ${path.basename(pack)})`);
	}
}


function run(command, args) {
	return spawn(command, args, { cwd: REPO, stdio: 'inherit', shell: isWindows, env: process.env });
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

/** Waits for the watcher to finish transpiling, echoing its output as it arrives. */
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
		const onData = (chunk, out) => {
			out.write(chunk);
			if (!done) {
				// A line can be split across chunks; keeping a tail makes the match survive that.
				seen = (seen + chunk.toString()).slice(-4096);
				if (TRANSPILED.test(seen)) {
					finish(true);
				}
			}
		};
		child.stdout?.on('data', chunk => onData(chunk, process.stdout));
		child.stderr?.on('data', chunk => onData(chunk, process.stderr));
		child.on('exit', code => finish(false));
		const timer = setTimeout(() => finish(false), timeoutMs);
	});
}

let watch;
let launched;

function stop(code) {
	if (launched !== undefined) {
		launched.kill();
	}
	if (watch !== undefined) {
		watch.kill();
	}
	process.exit(code);
}

// Only when run as a command: importing this file (a check, a test) must not start a watcher.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.on('SIGINT', () => stop(0));
	process.on('SIGTERM', () => stop(0));

	linkPackedRuntime();

	watch = spawn(npm, ['run', 'watch'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows, env: process.env });
	console.log('dev: compiling and watching -- the editor opens when out/ is complete');

	if (!(await waitForTranspile(watch))) {
		console.error('dev: the watcher did not finish transpiling in ten minutes; stopping.');
		stop(1);
	}

	console.log('dev: opening the editor (the first run also fetches Electron and the built-in extensions)');
	launched = isWindows
		? spawn('cmd.exe', ['/c', 'scripts\\code.bat', ...process.argv.slice(2)], { cwd: REPO, stdio: 'inherit', env: process.env })
		: run('bash', ['scripts/code.sh', ...process.argv.slice(2)]);

	launched.on('exit', code => stop(code ?? 0));
}
