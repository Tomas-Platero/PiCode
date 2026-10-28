/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PiToolDefinition } from './mcp';
import { pastConversationTools } from './past-conversations';
import { windowSessionScope } from './runtime';
import { areaConversationsReport, conversationsReport, sessionTurns } from './sessions-provider';

/**
 * The past-conversation tools over this window's own list — the same one the Sessions panel shows
 * (`sessions-register.ts`), read at every call so a conversation that ended a minute ago is there.
 * `agentDir` undefined is a chat on the owner's external pi, whose history is not PiCode's to read.
 */
export function windowPastConversationTools(agentDir: string | undefined, current: () => string | undefined): PiToolDefinition[] {
	if (agentDir === undefined) {
		return [];
	}
	const sessionsDir = path.join(agentDir, 'sessions');
	return pastConversationTools({
		list: () => {
			const scope = windowSessionScope();
			return scope.mode === 'workspace' && scope.slugs[0] !== undefined
				? areaConversationsReport(sessionsDir, scope.slugs[0]).files
				: conversationsReport(sessionsDir, scope.slugs).files;
		},
		current,
		turns: file => {
			let text: string;
			try {
				text = fs.readFileSync(file, 'utf8');
			} catch {
				return [];
			}
			return sessionTurns(text);
		},
	});
}
