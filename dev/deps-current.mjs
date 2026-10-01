#!/usr/bin/env node
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
 * what dev/build.sh phase 2 does when distribution/product-delta.json changes) changes that
 * file's hash, so the build right after a version bump reinstalls. The version cannot affect
 * which packages are installed, but proving that would mean reimplementing VS Code's hash,
 * and the build prefers to install once too often than to trust a tree it has not checked.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

console.log(`  the recorded dependency state matches this tree (node ${current.nodeVersion})`);
