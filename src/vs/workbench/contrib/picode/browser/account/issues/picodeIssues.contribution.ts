/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { isJiraProjectKey, parseGithubRepoRef } from './picodeIssueBoard.js';
import { PicodeIssueSource } from './picodeIssueSources.js';
import { PicodeIssuesEditor } from './picodeIssuesEditor.js';
import { IPicodeIssuesEditorOptions, PICODE_ISSUES_EDITOR_ID, PICODE_ISSUES_EDITOR_INPUT_ID, PicodeIssuesEditorInput } from './picodeIssuesEditorInput.js';

/** Opens the viewer of a project: `picode.issues.open(source, ref, selectKey?)`. */
export const PICODE_OPEN_ISSUES_COMMAND = 'picode.issues.open';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PicodeIssuesEditor, PICODE_ISSUES_EDITOR_ID, localize('picodeIssuesEditor', "Issues")),
	// SAFETY: the registry never builds the input itself; the serializer and the command do, with their own arguments.
	[new SyncDescriptor(PicodeIssuesEditorInput as unknown as { new(): PicodeIssuesEditorInput })]
);

function isSource(value: unknown): value is PicodeIssueSource {
	return value === 'github' || value === 'jira';
}

function isRef(source: PicodeIssueSource, ref: unknown): ref is string {
	return typeof ref === 'string' && (source === 'jira' ? isJiraProjectKey(ref) : parseGithubRepoRef(ref) !== undefined);
}

/** Tabs come back after a restart; only the project is kept, the data is read again. */
class PicodeIssuesEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof PicodeIssuesEditorInput;
	}
	serialize(editorInput: EditorInput): string | undefined {
		return editorInput instanceof PicodeIssuesEditorInput ? JSON.stringify({ source: editorInput.source, ref: editorInput.ref }) : undefined;
	}
	deserialize(_instantiationService: IInstantiationService, serialized: string): PicodeIssuesEditorInput | undefined {
		try {
			const data: unknown = JSON.parse(serialized);
			const { source, ref } = (typeof data === 'object' && data !== null ? data : {}) as { source?: unknown; ref?: unknown };
			return isSource(source) && isRef(source, ref) ? new PicodeIssuesEditorInput(source, ref) : undefined;
		} catch {
			return undefined;
		}
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(PICODE_ISSUES_EDITOR_INPUT_ID, PicodeIssuesEditorInputSerializer);

CommandsRegistry.registerCommand(PICODE_OPEN_ISSUES_COMMAND, async (accessor, source: unknown, ref: unknown, selectKey?: unknown) => {
	if (!isSource(source) || !isRef(source, ref)) {
		return;
	}
	const options: IPicodeIssuesEditorOptions = { pinned: true, selectKey: typeof selectKey === 'string' ? selectKey : undefined };
	await accessor.get(IEditorService).openEditor(new PicodeIssuesEditorInput(source, ref), options);
});
