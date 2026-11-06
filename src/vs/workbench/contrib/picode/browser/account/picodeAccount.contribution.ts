/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { PicodeAccountEditor } from './picodeAccountEditor.js';
import { PICODE_ACCOUNT_EDITOR_ID, PICODE_ACCOUNT_EDITOR_INPUT_ID, PicodeAccountEditorInput } from './picodeAccountEditorInput.js';
import './picodeAccountOverviewSection.js';
import './picodeAccountSyncSection.js';
import './picodeConnectionsSection.js';
import './picodeProFeaturesSection.js';

export const PICODE_OPEN_ACCOUNT_COMMAND = 'picode.account.open';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PicodeAccountEditor, PICODE_ACCOUNT_EDITOR_ID, localize('picodeAccountEditor', "Account")),
	// SAFETY: the registry instantiates the input class through its zero-argument constructor.
	[new SyncDescriptor(PicodeAccountEditorInput as unknown as { new(): PicodeAccountEditorInput })]
);

class PicodeAccountEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof PicodeAccountEditorInput;
	}
	serialize(): string {
		return '';
	}
	deserialize(_instantiationService: IInstantiationService): PicodeAccountEditorInput {
		return PicodeAccountEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PICODE_ACCOUNT_EDITOR_INPUT_ID, PicodeAccountEditorInputSerializer);

registerAction2(class OpenPicodeAccountAction extends Action2 {
	constructor() {
		super({
			id: PICODE_OPEN_ACCOUNT_COMMAND,
			title: localize2('picodeOpenAccount', "PiCode: Open Account"),
			f1: true,
			menu: { id: MenuId.AccountsContext, group: '0_picode', order: 0 },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(PicodeAccountEditorInput.getOrCreate(), { pinned: true });
	}
});
