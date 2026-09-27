/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { externalSdkEntry } from './piLocate';
import { sdkCandidates } from './piSdk';

/**
 * Which pi runs as the editor's agent, and whose configuration it uses.
 *
 * One question, one answer. The internal pi is PiCode's own: the program pinned under
 * `resources/pi-runtime` and the profile inside the distribution (`data/pi-agent`), both
 * written only by PiCode. The external pi is the one on the machine's PATH with its own
 * profile (pi resolves `~/.pi/agent` by itself): PiCode **reads** it and never writes to it,
 * so everything PiCode projects for pi — providers, MCP servers, credentials — keeps living
 * in PiCode's own profile regardless of this choice.
 *
 * The answer is consumed in exactly two shapes:
 *
 * - `sdkEntryCandidates()` — where the SDK is loaded from. The empty list in external mode
 *   means "there is no pi on this machine's PATH", and the loader says so instead of
 *   silently falling back to the internal one.
 * - `chatAgentDir()` — the `agentDir` the chat's sessions run against. `undefined` in
 *   external mode is deliberate: it means "do not set the directory", so pi resolves its own
 *   default exactly as it does from a terminal.
 */

/** The runtime modes the wizard and the setting offer. */
export type PiRuntimeMode = 'internal' | 'external';

/** The setting the choice is stored in. */
export const PICODE_RUNTIME_SETTING = 'picode.pi.runtime';

/** The mode in force. Anything unrecognised means the internal pi. */
export function readRuntimeMode(): PiRuntimeMode {
	// The root configuration with the FULL key: this constant is the registered setting's
	// name (`picode.pi.runtime`), and a section configuration would prepend `picode` again,
	// landing on a key nobody registered — which reads as "internal" forever.
	const configured = vscode.workspace.getConfiguration().get<string>(PICODE_RUNTIME_SETTING);
	return configured === 'external' ? 'external' : 'internal';
}

/** PiCode's own profile, inside the distribution. Every PiCode write lands here. */
export function internalProfileDir(distributionRoot: string): string {
	return path.join(distributionRoot, 'data', 'pi-agent');
}

/** Where the SDK is loaded from, for the mode in force. */
export function sdkEntryCandidates(distributionRoot: string): string[] {
	if (readRuntimeMode() === 'external') {
		const entry = externalSdkEntry();
		return entry === undefined ? [] : [entry];
	}
	return sdkCandidates(distributionRoot);
}

/**
 * The profile the chat's pi sessions run against.
 *
 * The internal profile when the internal pi runs; `undefined` for the external one, which
 * is not a gap but the instruction to let pi use its own directory.
 */
export function chatAgentDir(distributionRoot: string): string | undefined {
	return readRuntimeMode() === 'internal' ? internalProfileDir(distributionRoot) : undefined;
}
