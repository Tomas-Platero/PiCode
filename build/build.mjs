/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// `npm run build`: the whole build in one command, on any channel and any operating system.
//
//   npm run build                       portable pack for the current branch's channel
//   npm run build -- --channel beta     portable pack for another channel (stable | beta | experimental)
//   npm run build -- --installer        also build the installer (off by default)
//
// It only sets the environment `build/build.sh` reads and runs it, so the channel is spelled the
// same way on Windows, macOS and Linux (an inline `VAR=value command` does not work in cmd).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANNELS = ['stable', 'beta', 'experimental'];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function fail(message) {
	console.error(message);
	process.exit(1);
}

const env = { ...process.env };
let installer = false;
const passthrough = [];

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--installer') {
		installer = true;
	} else if (arg === '--channel' || arg.startsWith('--channel=')) {
		const value = arg === '--channel' ? args[++i] : arg.slice('--channel='.length);
		if (!CHANNELS.includes(value)) {
			fail(`Unknown channel "${value}". Use one of: ${CHANNELS.join(', ')}.`);
		}
		env.PICODE_CHANNEL = value;
	} else {
		passthrough.push(arg);
	}
}

if (!installer) {
	env.PICODE_SKIP_INSTALLER = 'yes';
}

// With no --channel, build.sh picks the channel the current branch owns (or the caller's own
// PICODE_CHANNEL) — the same rule it always had.
const result = spawnSync('bash', [join(root, 'build', 'build.sh'), ...passthrough], { cwd: root, env, stdio: 'inherit' });
if (result.error) {
	fail(`Could not run bash (${result.error.message}). On Windows, install Git for Windows and run this from its terminal.`);
}
process.exit(result.status ?? 1);
