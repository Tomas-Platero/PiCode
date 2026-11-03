/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { IChatProgressRenderableResponseContent } from '../../../common/model/chatModel.js';
import { IChatCommandButton } from '../../../common/chatService/chatService.js';
import { isResponseVM } from '../../../common/model/chatViewModel.js';
import { Command } from '../../../../../../editor/common/languages.js';

const $ = dom.$;

/** The connector's command behind the change card's undo button. */
const PICODE_UNDO_TURN_EDITS_COMMAND = 'picode.undoTurnEdits';

export class ChatCommandButtonContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		commandButton: IChatCommandButton,
		context: IChatContentPartRenderContext,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();

		this.domNode = $('.chat-command-button');
		const enabled = !isResponseVM(context.element) || !context.element.isStale;

		// Render the primary button
		this.renderButton(this.domNode, commandButton.command, enabled);

		// Render additional buttons if any
		if (commandButton.additionalCommands) {
			for (const command of commandButton.additionalCommands) {
				this.renderButton(this.domNode, command, enabled, true);
			}
		}
	}

	private renderButton(container: HTMLElement, command: Command, enabled: boolean, secondary?: boolean): void {
		const tooltip = enabled ?
			command.tooltip :
			localize('commandButtonDisabled', "Button not available in restored chat");
		// PiCode: the change card's undo is a quiet action next to the card, not the answer's main button,
		// and it greys out once it has run (its command answers `true` when the changes were put back).
		const undoesChanges = command.id === PICODE_UNDO_TURN_EDITS_COMMAND;
		const button = this._register(new Button(container, { ...defaultButtonStyles, supportIcons: true, title: tooltip, secondary: secondary || undoesChanges }));
		button.label = command.title;
		button.enabled = enabled;

		// TODO still need telemetry for command buttons
		this._register(button.onDidClick(async () => {
			const result = await this.commandService.executeCommand(command.id, ...(command.arguments ?? []));
			if (undoesChanges && result === true) {
				button.enabled = false;
			}
		}));
	}

	hasSameContent(other: IChatProgressRenderableResponseContent): boolean {
		// No other change allowed for this content type
		return other.kind === 'command';
	}
}
