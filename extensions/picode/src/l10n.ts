/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.  Licensed under the MIT License.
 *  See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `l10n.t` for modules that must load without the editor (the setup host and the plain-Node
 * tests). Inside the editor it is `vscode.l10n.t`, so the bundle in `l10n/` translates it; outside
 * it the English sentence is returned with its `{0}` placeholders filled. Files that already
 * import `vscode` call `vscode.l10n.t` directly. `build/l10n.mjs` extracts both spellings.
 */

type Placeholder = string | number | boolean;
type EditorL10n = { t(message: string, ...args: Placeholder[]): string };

function editorL10n(): EditorL10n | undefined {
	try {
		// Resolved lazily and guarded: `vscode` does not exist in plain Node.
		return typeof require === 'function' ? (require('vscode') as { l10n?: EditorL10n }).l10n : undefined;
	} catch {
		return undefined;
	}
}

export const l10n = {
	t(message: string, ...args: Placeholder[]): string {
		const translate = editorL10n();
		if (translate !== undefined) {
			return translate.t(message, ...args);
		}
		return message.replace(/\{(\d+)\}/g, (whole, index: string) => index in args ? String(args[Number(index)]) : whole);
	},
};
