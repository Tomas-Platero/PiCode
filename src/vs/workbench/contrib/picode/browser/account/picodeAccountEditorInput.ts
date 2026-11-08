/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IModalEditorOptions, IModalEditorOptionsProvider } from '../../../../../platform/editor/common/editor.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

export const PICODE_ACCOUNT_EDITOR_ID = 'workbench.editor.picodeAccount';
export const PICODE_ACCOUNT_EDITOR_INPUT_ID = 'workbench.input.picodeAccount';

/** The Account window: one singleton input with no file behind it, opened as a modal like Chat Settings. */
export class PicodeAccountEditorInput extends EditorInput implements IModalEditorOptionsProvider {
	static readonly ID = PICODE_ACCOUNT_EDITOR_INPUT_ID;
	readonly resource = undefined;

	private static instance: PicodeAccountEditorInput | undefined;

	static getOrCreate(): PicodeAccountEditorInput {
		if (!PicodeAccountEditorInput.instance || PicodeAccountEditorInput.instance.isDisposed()) {
			PicodeAccountEditorInput.instance = new PicodeAccountEditorInput();
		}
		return PicodeAccountEditorInput.instance;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton | EditorInputCapabilities.RequiresModal;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof PicodeAccountEditorInput;
	}

	override get typeId(): string {
		return PicodeAccountEditorInput.ID;
	}

	override getName(): string {
		return localize('picodeAccountEditorName', "Account");
	}

	override getIcon(): ThemeIcon {
		return Codicon.account;
	}

	getModalEditorOptions(): IModalEditorOptions {
		return { compactHeader: true };
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
