/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatResponseModel } from '../../chat/common/model/chatModel.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';

/** The chat participant the connector declares. */
const PICODE_AGENT_ID = 'picode.pi';

/**
 * A turn pi ran on its own after the chat's answer closed (a background job ended and pi reacted):
 * the extension API cannot write to a closed answer, so the connector hands it here and it becomes
 * a finished entry of that conversation.
 *
 * A conversation that is not open has nowhere to show it, and that is not a fault: pi's own
 * transcript keeps what was said.
 */
CommandsRegistry.registerCommand('picode.chat.addLateTurn', async (accessor, sessionResource: unknown, request: unknown, answer: unknown) => {
	if (typeof sessionResource !== 'string' || !sessionResource.includes(':') || typeof request !== 'string' || typeof answer !== 'string') {
		return;
	}
	const chatService = accessor.get(IChatService);
	const agentService = accessor.get(IChatAgentService);
	const logService = accessor.get(ILogService);
	try {
		const resource = URI.parse(sessionResource);
		await chatService.addCompleteRequest(resource, request, undefined, undefined, {
			message: [{ kind: 'markdownContent', content: new MarkdownString(answer) }],
		});
		// An entry added like this names no agent, and would be drawn with a generic icon.
		const response = chatService.getSession(resource)?.lastRequest?.response;
		const agent = agentService.getAgent(PICODE_AGENT_ID);
		if (response instanceof ChatResponseModel && agent) {
			response.setAgent(agent);
		}
	} catch (error) {
		logService.trace('[picode.chat] a late turn found no open conversation', error);
	}
});
