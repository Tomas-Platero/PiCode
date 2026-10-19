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
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const READY = path.join(REPO, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

function run(command, args) {
	return spawn(command, args, { cwd: REPO, stdio: 'inherit', shell: isWindows, env: process.env });
}

async function waitForReady() {
	const started = Date.now();
	while (!existsSync(READY)) {
		if (Date.now() - started > 10 * 60 * 1000) {
			return false;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	return true;
}

const watch = run(npm, ['run', 'watch']);
console.log('dev: watcher running -- save a file and it recompiles that file');

let launched;
const stop = code => {
	if (launched !== undefined) {
		launched.kill();
	}
	watch.kill();
	process.exit(code);
};

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (!(await waitForReady())) {
	console.error('dev: the watcher did not produce out/ in ten minutes; stopping.');
	stop(1);
}

console.log('dev: opening the editor (the first run also fetches Electron and the built-in extensions)');
launched = isWindows
	? spawn('cmd.exe', ['/c', 'scripts\\code.bat', ...process.argv.slice(2)], { cwd: REPO, stdio: 'inherit', env: process.env })
	: run('bash', ['scripts/code.sh', ...process.argv.slice(2)]);

launched.on('exit', code => stop(code ?? 0));
