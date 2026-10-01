/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Signing in to one MCP server, as far as it can be decided without running anything.
 *
 * A server that authenticates with OAuth keeps its credentials in pi's own profile, and **pi is the
 * one that owns them**: `pi mcp login <server>` starts a local callback, opens the browser and stores
 * the tokens, and `pi mcp logout <server>` deletes them (`dist/extensions/mcp/cli.js`). This
 * connector does not implement OAuth a second time; it runs those commands against PiCode's profile,
 * which is where the credentials then live, and reads out of what pi printed the address to offer if
 * the browser did not open.
 *
 * The rules for that reading are here, pure, so they can be exercised by running them —
 * `extension.ts` is the part that needs the editor.
 */

/** The arguments pi's CLI needs to sign in to one server. */
export function loginArguments(server: string): string[] {
	return ['mcp', 'login', server];
}

/** The arguments pi's CLI needs to sign out of one server, which deletes its stored credentials. */
export function logoutArguments(server: string): string[] {
	return ['mcp', 'logout', server];
}

/** A server name as either command takes it: trimmed, or empty when there is nothing usable. */
export function serverTarget(name: string | undefined): string {
	return name?.trim() ?? '';
}

/**
 * The address pi printed for the owner to sign in at, or `undefined` when it printed none.
 *
 * pi writes it on its own line (`Sign in to MCP server "<name>" in your browser:` and then the
 * address), but what matters is the address: the first `http` or `https` URL of the output. A
 * sentence's trailing punctuation is not part of it.
 */
export function authorizationUrlIn(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const match = /https?:\/\/\S+/.exec(line.trim());
		if (match !== null) {
			return match[0].replace(/[)\].,;]+$/, '');
		}
	}
	return undefined;
}

/**
 * The last thing pi said that is worth repeating, or `undefined` when it said nothing usable.
 *
 * pi puts the reason on one line and, when it is a failure, on its error stream. Only the last one
 * is repeated: a failed sign-in writes a sentence about the failure, and the lines before it are
 * progress. It is cut at two hundred characters, because a notification is not a log.
 */
export function lastLineOf(text: string): string | undefined {
	const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
	const last = lines.at(-1);
	if (last === undefined) {
		return undefined;
	}
	return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}
