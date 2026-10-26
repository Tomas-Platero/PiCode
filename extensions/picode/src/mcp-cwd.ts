/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The MCP stdio transport's `cwd`, guarded by this editor.
 *
 * pi's built-in MCP extension decides a stdio server's working directory as
 * `resolve(sessionCwd, expandHome(config.cwd ?? '.'))` (`extensions/mcp/runtime.js:67`) and hands
 * it to the transport, which spawns the server there (`pi-mcp/dist/transports/stdio.js:77`). When
 * that directory does not exist, Node answers the spawn with ENOENT **naming the command** —
 * `spawn node ENOENT`, and for the `.cmd` shims cross-spawn routes through cmd.exe,
 * `spawn C:\WINDOWS\system32\cmd.exe ENOENT` — the chat's "MCP servers need attention" wall,
 * where eight healthy commands were blamed for one missing directory.
 *
 * The guard keeps pi's resolution byte-for-byte, and then applies two rules:
 *
 * 1. A missing directory never stops a server. It starts in the session directory, or the home
 *    one when even that is gone, and the log says the directory does not exist — so the one
 *    sentence the owner reads is true.
 * 2. When no directory can be resolved at all, the error says *that*: it names the directory and
 *    never pretends the command failed to spawn.
 *
 * The replacement is pi's own built-in factory (`createMcpExtension`) with this one option
 * changed — no copy of pi's logic beyond the resolution it documents — so everything else the
 * extension does (config, OAuth, `/mcp`) stays pi's.
 */

import { statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The server config this guard reads, reduced to the fields that decide the directory. */
export interface McpServerEntryConfig {
	/** A URL server has no directory; stdio servers may carry one, relative or `~`-shaped. */
	url?: unknown;
	cwd?: unknown;
	[key: string]: unknown;
}

/** The transport factory's shape as pi's MCP extension calls it. */
export type McpTransportFactory = (entry: unknown, cwd: string, authProvider: unknown) => unknown;

/** The built-in entry this module returns, in pi's `builtInExtensions` shape. */
export interface McpBuiltinExtension {
	readonly name: string;
	readonly factory: (pi: unknown) => void | Promise<void>;
	readonly builtin: true;
	readonly replaceable: true;
}

interface McpRuntimeModule {
	createDefaultTransport: McpTransportFactory;
}

interface McpExtensionModule {
	createMcpExtension: (options?: { createTransport?: McpTransportFactory }) => (pi: unknown) => void | Promise<void>;
}

/**
 * The genuine dynamic `import()`, built at runtime — the same one-liner `piSdk.ts` carries, and
 * for the same reason: this module compiles to CommonJS, where a plain `import(expression)`
 * becomes `require()` and cannot load pi's ESM. It is repeated here rather than imported so
 * this module stays leaf-only (node built-ins only) and the plain `node --test` runner can
 * load it without a build step — see `test/mcp-cwd.test.ts`.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

function importPiModule<T>(entry: string): Promise<T> {
	return dynamicImport(pathToFileURL(entry).href) as Promise<T>;
}

/** True only for a directory that is there right now. A file with the same name is not. */
function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * `~` and `~/…` (also `~\…` on Windows) name the home directory — the same rule pi's MCP runtime
 * applies (`extensions/mcp/runtime.js`, `expandHome`). Kept here because the guard must resolve
 * the server's directory *before* pi does, or it could never speak about it.
 */
export function expandMcpHome(value: string, home: string): string {
	if (value === '~') {
		return home;
	}
	if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) {
		return path.join(home, value.slice(2));
	}
	return value;
}

/** The directory the server would be spawned in, exactly as pi's own transport computes it. */
export function resolveMcpServerCwd(config: McpServerEntryConfig, sessionCwd: string, home: string): string {
	const configured = typeof config.cwd === 'string' ? config.cwd : '.';
	return path.resolve(sessionCwd, expandMcpHome(configured, home));
}

/**
 * The guarded transport factory, in the shape pi's MCP extension accepts as `options.createTransport`.
 *
 * `createDefaultTransport` is pi's own (injected, so the tests run without pi); `home` likewise.
 */
export function createCwdSafeTransport(deps: {
	createDefaultTransport: McpTransportFactory;
	home: string;
	log: (line: string) => void;
}): McpTransportFactory {
	return (entry, sessionCwd, authProvider) => {
		const server = entry as { name: string; config?: McpServerEntryConfig };
		const config = server.config ?? {};
		// A URL server is spawned nowhere: pi's own factory builds an HTTP transport for it.
		if (config.url !== undefined) {
			return deps.createDefaultTransport(entry, sessionCwd, authProvider);
		}
		const wanted = resolveMcpServerCwd(config, sessionCwd, deps.home);
		if (isDirectory(wanted)) {
			return deps.createDefaultTransport(entry, sessionCwd, authProvider);
		}
		const fallback = isDirectory(sessionCwd) ? sessionCwd : deps.home;
		if (!isDirectory(fallback)) {
			// The one case the fallback cannot save: say what is wrong, and where.
			throw new Error(
				`MCP server "${server.name}" could not start: the working directory "${wanted}" does not exist, and no directory to fall back to could be found.`,
			);
		}
		deps.log(`MCP server "${server.name}": the working directory "${wanted}" does not exist — starting in "${fallback}" instead.`);
		return deps.createDefaultTransport(entry, fallback, authProvider);
	};
}

/**
 * pi's built-in `mcp` extension, rebuilt with the guarded transport, from the install the session
 * is actually built against (`sdkEntry` — never from a searched-for pi, which could be another).
 *
 * `undefined` when pi's modules could not be loaded: the session then keeps pi's own factory
 * untouched, which is today's behavior — degraded, not broken — and the log says why.
 */
export async function mcpBuiltinWithExistingCwd(
	sdkEntry: string,
	log: (line: string) => void,
): Promise<McpBuiltinExtension | undefined> {
	const besideEntry = path.join(path.dirname(sdkEntry), 'extensions', 'mcp');
	try {
		const [extension, runtime] = await Promise.all([
			importPiModule<McpExtensionModule>(path.join(besideEntry, 'index.js')),
			importPiModule<McpRuntimeModule>(path.join(besideEntry, 'runtime.js')),
		]);
		return {
			name: 'mcp',
			factory: extension.createMcpExtension({
				createTransport: createCwdSafeTransport({
					createDefaultTransport: (entry, cwd, authProvider) => runtime.createDefaultTransport(entry, cwd, authProvider),
					home: os.homedir(),
					log,
				}),
			}),
			builtin: true,
			replaceable: true,
		};
	} catch (error) {
		log(`pi's MCP extension could not be wrapped with the working-directory guard: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
