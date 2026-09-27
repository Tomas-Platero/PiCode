#!/usr/bin/env node
/*
 * What the build needs, in one place.
 *
 * Two front-ends ask this question — the PowerShell window and the C# builder — and a third (the
 * terminal) may want it later. Each one used to work it out on its own, which is two copies of the
 * same truth and one of them always ends up stale. This is that truth: the checks, what each one is
 * for, and how to get it.
 *
 * Usage: node dev/build-requirements.mjs [--json]
 *
 *   --json   one object: the platform, whether anything blocks a build, and one entry per check with
 *            its name, whether it is there, what was found, and how to install it.
 *   (plain)  one line per check, for a person in a terminal.
 *
 * Platform matters: a check about the editor being closed is about Windows, where the build replaces
 * a folder Windows will not let go of while a program is running. On Linux it is not asked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const bs = String.fromCharCode(92);

const REPO = path.resolve(import.meta.dirname, '..');
const json = process.argv.includes('--json');

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
const nodeVersion = run('node', ['--version']).replace(/^v/, '');
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
const git = run('git', ['--version']);
const hasBash = run(isWindows ? 'bash' : 'sh', ['-c', 'echo yes']) === 'yes';
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
		const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PiCode.exe', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		running = /PiCode\.exe/i.test(out);
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
// not stop a build that would have worked, and the pipeline itself decides that - it demands only jq,
// git and node, and the rest is what installing the dependencies needs.
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
