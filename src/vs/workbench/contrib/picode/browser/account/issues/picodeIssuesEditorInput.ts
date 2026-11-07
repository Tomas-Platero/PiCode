/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IEditorOptions } from '../../../../../../platform/editor/common/editor.js';
import { IUntypedEditorInput } from '../../../../../common/editor.js';
import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { PicodeIssueSource } from './picodeIssueSources.js';

export const PICODE_ISSUES_EDITOR_ID = 'workbench.editor.picodeIssues';
export const PICODE_ISSUES_EDITOR_INPUT_ID = 'workbench.input.picodeIssues';

/** Opening an issues tab that is already open: which issue to select in it. */
export interface IPicodeIssuesEditorOptions extends IEditorOptions {
	readonly selectKey?: string;
}

/**
 * One tab per Jira project or GitHub repository. There is no file behind it: the address only
 * tells two tabs of the same project apart from tabs of another one.
 */
export class PicodeIssuesEditorInput extends EditorInput {
	static readonly ID = PICODE_ISSUES_EDITOR_INPUT_ID;

	readonly resource: URI;

	constructor(readonly source: PicodeIssueSource, readonly ref: string) {
		super();
		this.resource = URI.from({ scheme: 'picode-issues', authority: source, path: `/${ref}` });
	}

	override get typeId(): string {
		return PicodeIssuesEditorInput.ID;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || (otherInput instanceof PicodeIssuesEditorInput && otherInput.resource.toString() === this.resource.toString());
	}

	/** The tab's name: `Jira - ATW`, or `GitHub - PiCode` (the repository's own name). */
	override getName(): string {
		return this.source === 'github' ? `GitHub - ${this.ref.slice(this.ref.indexOf('/') + 1)}` : `Jira - ${this.ref}`;
	}

	override getTitle(): string {
		return this.source === 'github' ? this.ref : `Jira · ${this.ref}`;
	}

	override getIcon(): ThemeIcon {
		return Codicon.issues;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
