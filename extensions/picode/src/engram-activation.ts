/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wakes the memory up when the editor starts, and leaves it declared to pi.
 *
 * Two things happen, in this order and for different reasons:
 *
 *  1. **The declaration**, because it is a file write and it is what gives every chat session its
 *     memory tools. It does not wait for the engine to be awake: pi reads `mcp.json` when a
 *     session starts, and the session's own `engram mcp` process opens the store by itself.
 *  2. **The wake-up**, because the editor's own surfaces read over HTTP and need somebody serving.
 *     It runs detached and outlives the window: the store is the user's and is shared with
 *     whatever other agent on the machine points at it, so a server left serving is the normal
 *     state, not a leak. The next start joins it instead of opening another.
 *
 * Nothing here can break a turn. Every failure is one line in the log and a state the surfaces
 * read; the chat keeps answering without memory, which is the whole point of memory being support.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	engramBinaryName,
	firstEngramBinary,
	engramStateLine,
	ensureEngramServer,
	isOurEngramDeclaration,
	nodeEngramProbeIo,
	SHIPPED_ENGRAM_FOLDER,
	type EngramProbeIo
} from './engram';
import { mcpServersTextWithRemoved, serverEntry } from './mcp-add';

/** The setting that turns memory on and off, and the context key the Memory block hangs on. */
export const MEMORY_ENABLED_SETTING = 'picode.memory.enabled';
export const MEMORY_BINARY_SETTING = 'picode.memory.binary';

/** On unless the owner said otherwise: the product ships with memory working. */
export function memoryEnabled(): boolean {
	return vscode.workspace.getConfiguration('picode.memory').get<boolean>('enabled') !== false;
}

/** Everything memory needs from the editor, in one place so the tests can leave the editor out. */
function memoryIo(): EngramProbeIo {
	const configured = vscode.workspace.getConfiguration('picode.memory').get<string>('binary');
	return nodeEngramProbeIo({
		env: process.env,
		home: os.homedir(),
		appRoot: vscode.env.appRoot,
		workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
		configured: typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined
	});
}

/** Reads the profile's MCP file as an object, or `undefined` when there is nothing usable there. */
function readServersFile(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** Runs the engine detached, so it serves this store while the window is open and after it closes. */
function spawnDetached(binary: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): void {
	const child = spawn(binary, [...args], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...env } as NodeJS.ProcessEnv
	});
	child.unref();
}

/**
 * Takes out the `engram` server this product used to write into the profile's `mcp.json`.
 *
 * Memory reaches pi through gentle-engram now (ADR-030), which brings its own tools: a second
 * set through MCP would offer the model the same memory twice. Only the declaration this
 * product wrote leaves; one the owner wrote or changed stays. The store itself is never touched:
 * turning memory off is not deleting what it remembers, and a person who switches back on finds
 * everything where it was.
 */
export function forgetMemory(profileDir: string, log: (line: string) => void): void {
	const file = path.join(profileDir, 'mcp.json');
	const existing = readServersFile(file);
	if (isOurEngramDeclaration(serverEntry(existing, 'engram'))) {
		const text = mcpServersTextWithRemoved(existing, 'engram');
		if (text !== undefined) {
			try {
				fs.writeFileSync(file, text, { mode: 0o600 });
				log('memory: the engram server this product declared was removed from the profile');
			} catch (error) {
				log(`memory: the declaration could not be removed — ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

/** The folder this installation carries the engine in, when it carries one. */
function shippedEngineFolder(): string | undefined {
	const folder = path.join(vscode.env.appRoot, 'resources', SHIPPED_ENGRAM_FOLDER);
	return fs.existsSync(path.join(folder, engramBinaryName())) ? folder : undefined;
}

/** How the terminal's environment setting is spelled on this platform. */
function terminalEnvKey(): { readonly key: string; readonly separator: string } {
	if (process.platform === 'win32') {
		return { key: 'windows', separator: ';' };
	}
	return { key: process.platform === 'darwin' ? 'osx' : 'linux', separator: ':' };
}

/**
 * Puts the engine on the integrated terminal's PATH, so typing `engram` in there does something.
 *
 * There is no API for an extension to hand a terminal an extra folder, so this is the editor's own
 * setting, written the only safe way: the folder is **prepended** to whatever PATH already is, and
 * `${env:PATH}` is used when the owner never set one — never a bare folder, which would replace
 * the whole PATH with it. The value is read first, so a second activation and a PATH the owner
 * edited by hand are both left alone.
 */
function exposeOnTerminalPath(log: (line: string) => void): void {
	const folder = shippedEngineFolder();
	if (folder === undefined) {
		return;
	}
	const { key, separator } = terminalEnvKey();
	const config = vscode.workspace.getConfiguration('terminal.integrated.env');
	const current = config.get<Record<string, string>>(key) ?? {};
	const pathKey = Object.keys(current).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
	const value = current[pathKey];
	if (typeof value === 'string' && value.split(separator).includes(folder)) {
		return;
	}
	const base = typeof value === 'string' && value.trim() !== '' ? value : '${env:PATH}';
	void config.update(key, { ...current, [pathKey]: `${folder}${separator}${base}` }, vscode.ConfigurationTarget.Global).then(
		undefined,
		(error: unknown) => log(`memory: the terminal PATH could not be updated — ${error instanceof Error ? error.message : String(error)}`)
	);
}

/** Takes our folder back out of the terminal's PATH, leaving every other entry as it was. */
function hideFromTerminalPath(log: (line: string) => void): void {
	const folder = shippedEngineFolder();
	if (folder === undefined) {
		return;
	}
	const { key, separator } = terminalEnvKey();
	const config = vscode.workspace.getConfiguration('terminal.integrated.env');
	const current = config.get<Record<string, string>>(key) ?? {};
	const pathKey = Object.keys(current).find(name => name.toUpperCase() === 'PATH');
	const value = pathKey === undefined ? undefined : current[pathKey];
	if (pathKey === undefined || typeof value !== 'string') {
		return;
	}
	const parts = value.split(separator);
	const kept = parts.filter(entry => entry !== folder);
	if (kept.length === parts.length) {
		return;
	}
	void config.update(key, { ...current, [pathKey]: kept.join(separator) }, vscode.ConfigurationTarget.Global).then(
		undefined,
		(error: unknown) => log(`memory: the terminal PATH could not be restored — ${error instanceof Error ? error.message : String(error)}`)
	);
}

/**
 * Called once at activation, and again whenever the switch or the binary changes. Never awaited by
 * the caller and never throws: a window that opens without memory is a window, and the owner finds
 * out from the block, not from a dialog.
 */
export function startMemory(profileDir: string, log: (line: string) => void): void {
	if (!memoryEnabled()) {
		forgetMemory(profileDir, log);
		hideFromTerminalPath(log);
		// With no engine named, gentle-engram finds none of ours and has nothing to open.
		delete process.env['ENGRAM_BIN'];
		log('memory: turned off in the settings');
		return;
	}
	// The memory tools are gentle-engram's, not an MCP server's: an old declaration would offer the
	// model the same memory twice.
	forgetMemory(profileDir, log);
	const io = memoryIo();
	exposeOnTerminalPath(log);
	// gentle-engram runs the engine it is told to — the one this installation carries — so the memory
	// the chat reads is the memory the panel shows. It reads the answer once, when pi loads it, so it
	// is set here, before anything waits.
	const binary = firstEngramBinary(io);
	if (binary !== undefined) {
		process.env['ENGRAM_BIN'] = binary;
	}
	void (async () => {
		const settled = await ensureEngramServer(io, { spawn: spawnDetached });
		log(`memory: ${engramStateLine(settled.state)}`);
	})().catch(error => {
		log(`memory: ${error instanceof Error ? error.message : String(error)}`);
	});
}
