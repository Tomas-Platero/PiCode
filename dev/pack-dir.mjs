#!/usr/bin/env node
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
 * Run directly (`node dev/pack-dir.mjs`) and it prints the folder, which is how the CI workflow
 * resolves it without repeating this rule in YAML.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const pack = resolvePack(REPO);
	if (!fs.existsSync(pack)) {
		process.stderr.write('error: no packed folder found (build the editor first, ./dev/build.sh).\n');
		process.exit(1);
	}
	process.stdout.write(`${pack}\n`);
}
