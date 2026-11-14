/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { ILocalizedString, localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ITextEditorOptions, TextEditorSelectionRevealType } from '../../../../platform/editor/common/editor.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IListService } from '../../../../platform/list/browser/listService.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { MultiDiffEditor } from './multiDiffEditor.js';
import { MultiDiffEditorInput } from './multiDiffEditorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ActiveEditorContext, IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ActiveMultiDiffEditorHasFileListContext, isMultiDiffEditorFileListHost, MultiDiffEditorFileListAvailableContext, TOGGLE_MULTI_DIFF_EDITOR_FILE_LIST_COMMAND_ID, MultiDiffEditorFileListEnabledContext, MultiDiffEditorFileListPosition, MultiDiffEditorFileListPositionContext, MultiDiffEditorFileListViewMode, MultiDiffEditorFileListViewModeContext, MultiDiffEditorFilesViewAndPositionMenu, setMultiDiffEditorFileListPosition, setMultiDiffEditorFileListViewMode, toggleMultiDiffEditorFileList } from '../common/multiDiffEditor.js';

// The Agents window does not show the workbench's file list actions in its editor title.
const filesViewWhen = ContextKeyExpr.and(ActiveMultiDiffEditorHasFileListContext, IsSessionsWindowContext.toNegated());

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	submenu: MultiDiffEditorFilesViewAndPositionMenu,
	title: localize('filesViewAndPosition', "Files View & Position"),
	group: 'z_files',
	when: filesViewWhen,
});

export class GoToFileAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.goToFile',
			title: localize2('goToFile', 'Open File'),
			icon: Codicon.goToFile,
			precondition: ActiveEditorContext.isEqualTo(MultiDiffEditor.ID),
			menu: {
				when: ActiveEditorContext.isEqualTo(MultiDiffEditor.ID),
				id: MenuId.MultiDiffEditorFileToolbar,
				order: 22,
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const uri = args[0] as URI;
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;
		let selections: Selection[] | undefined = undefined;
		if (!(activeEditorPane instanceof MultiDiffEditor)) {
			return;
		}

		const editor = activeEditorPane.tryGetCodeEditor(uri);
		if (editor) {
			selections = editor.editor.getSelections() ?? undefined;
		}

		let targetUri = uri;
		const item = activeEditorPane.findDocumentDiffItem(uri);
		if (item && item.goToFileUri) {
			targetUri = item.goToFileUri;
		}

		await editorService.openEditor({
			label: item?.goToFileEditorTitle,
			resource: targetUri,
			options: {
				selection: selections?.[0],
				selectionRevealType: TextEditorSelectionRevealType.CenterIfOutsideViewport,
			} satisfies ITextEditorOptions,
		});
	}
}

export class GoToNextChangeAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.goToNextChange',
			title: localize2('goToNextChange', 'Go to Next Change'),
			icon: Codicon.arrowDown,
			precondition: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
			menu: [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle].map(id => ({
				id,
				when: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
				group: 'navigation',
				order: 2
			})),
			keybinding: {
				primary: KeyMod.Alt | KeyCode.F5,
				weight: KeybindingWeight.EditorContrib,
				when: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;

		if (!(activeEditorPane instanceof MultiDiffEditor)) {
			return;
		}

		activeEditorPane.goToNextChange();
	}
}

export class GoToPreviousChangeAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.goToPreviousChange',
			title: localize2('goToPreviousChange', 'Go to Previous Change'),
			icon: Codicon.arrowUp,
			precondition: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
			menu: [MenuId.EditorTitle, MenuId.CompactWindowEditorTitle].map(id => ({
				id,
				when: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
				group: 'navigation',
				order: 1
			})),
			keybinding: {
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.F5,
				weight: KeybindingWeight.EditorContrib,
				when: ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID),
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;

		if (!(activeEditorPane instanceof MultiDiffEditor)) {
			return;
		}

		activeEditorPane.goToPreviousChange();
	}
}

export class FocusFileListAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.focusFileList',
			title: localize2('focusFileList', 'Focus File List'),
			// In any editor that supports the changed files list, also while the user has hidden it, as focusing the list shows it.
			precondition: MultiDiffEditorFileListAvailableContext,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const activeEditorPane = accessor.get(IEditorService).activeEditorPane;
		if (isMultiDiffEditorFileListHost(activeEditorPane)) {
			activeEditorPane.focusFileList();
		}
	}
}

export class ToggleFileListAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_MULTI_DIFF_EDITOR_FILE_LIST_COMMAND_ID,
			title: localize2('toggleFileList', 'Toggle Files'),
			icon: Codicon.listFlat,
			toggled: MultiDiffEditorFileListEnabledContext,
			precondition: filesViewWhen,
			menu: {
				id: MenuId.EditorTitle,
				when: filesViewWhen,
				group: 'navigation',
				order: 100001,
			},
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		toggleMultiDiffEditorFileList(accessor.get(IStorageService));
	}
}

abstract class SetFileListViewModeAction extends Action2 {
	constructor(id: string, title: ILocalizedString, private readonly _viewMode: MultiDiffEditorFileListViewMode) {
		super({
			id,
			title,
			toggled: MultiDiffEditorFileListViewModeContext.isEqualTo(_viewMode),
			precondition: ActiveMultiDiffEditorHasFileListContext,
			menu: {
				id: MultiDiffEditorFilesViewAndPositionMenu,
				group: '1_view',
				order: _viewMode === 'list' ? 1 : 2,
				when: ActiveMultiDiffEditorHasFileListContext,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		setMultiDiffEditorFileListViewMode(accessor.get(IStorageService), this._viewMode);
	}
}

export class ViewFileListAsTreeAction extends SetFileListViewModeAction {
	constructor() {
		super('multiDiffEditor.viewFileListAsTree', localize2('viewFileListAsTree', 'View as Tree'), 'tree');
	}
}

export class ViewFileListAsListAction extends SetFileListViewModeAction {
	constructor() {
		super('multiDiffEditor.viewFileListAsList', localize2('viewFileListAsList', 'View as List'), 'list');
	}
}

abstract class SetFileListPositionAction extends Action2 {
	constructor(id: string, title: ILocalizedString, private readonly _position: MultiDiffEditorFileListPosition) {
		super({
			id,
			title,
			toggled: MultiDiffEditorFileListPositionContext.isEqualTo(_position),
			precondition: ActiveMultiDiffEditorHasFileListContext,
			menu: {
				id: MultiDiffEditorFilesViewAndPositionMenu,
				group: '2_position',
				order: _position === 'left' ? 1 : 2,
				when: ActiveMultiDiffEditorHasFileListContext,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		setMultiDiffEditorFileListPosition(accessor.get(IStorageService), this._position);
	}
}

export class PositionFileListLeftAction extends SetFileListPositionAction {
	constructor() {
		super('multiDiffEditor.positionFileListLeft', localize2('positionFileListLeft', 'On the Left'), 'left');
	}
}

export class PositionFileListRightAction extends SetFileListPositionAction {
	constructor() {
		super('multiDiffEditor.positionFileListRight', localize2('positionFileListRight', 'On the Right'), 'right');
	}
}

export class CollapseAllAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.collapseAll',
			title: localize2('collapseAllDiffs', 'Collapse All Diffs'),
			icon: Codicon.collapseAll,
			precondition: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.not('multiDiffEditorAllCollapsed')),
			menu: [
				// In the agents window this action lives in the editor title overflow (...) menu instead of as a primary toolbar icon.
				{
					id: MenuId.EditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.not('multiDiffEditorAllCollapsed'), IsSessionsWindowContext.toNegated()),
					group: 'navigation',
					order: 100
				},
				// The compact window editor title has no overflow menu, so keep the primary toolbar icon there.
				{
					id: MenuId.CompactWindowEditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.not('multiDiffEditorAllCollapsed')),
					group: 'navigation',
					order: 100
				},
				{
					id: MenuId.EditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.not('multiDiffEditorAllCollapsed'), IsSessionsWindowContext),
					group: '4_collapse',
					order: 10
				}
			],
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resolvedContext = resolveCommandsContext(args, accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IListService));

		const groupContext = resolvedContext.groupedEditors[0];
		if (!groupContext) {
			return;
		}

		const editor = groupContext.editors[0];
		if (editor instanceof MultiDiffEditorInput) {
			const viewModel = await editor.getViewModel();
			viewModel.collapseAll();
		}
	}
}

export class ExpandAllAction extends Action2 {
	constructor() {
		super({
			id: 'multiDiffEditor.expandAll',
			title: localize2('ExpandAllDiffs', 'Expand All Diffs'),
			icon: Codicon.expandAll,
			precondition: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.has('multiDiffEditorAllCollapsed')),
			menu: [
				// In the agents window this action lives in the editor title overflow (...) menu instead of as a primary toolbar icon.
				{
					id: MenuId.EditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.has('multiDiffEditorAllCollapsed'), IsSessionsWindowContext.toNegated()),
					group: 'navigation',
					order: 100
				},
				// The compact window editor title has no overflow menu, so keep the primary toolbar icon there.
				{
					id: MenuId.CompactWindowEditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.has('multiDiffEditorAllCollapsed')),
					group: 'navigation',
					order: 100
				},
				{
					id: MenuId.EditorTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('activeEditor', MultiDiffEditor.ID), ContextKeyExpr.has('multiDiffEditorAllCollapsed'), IsSessionsWindowContext),
					group: '4_collapse',
					order: 10
				}
			],
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resolvedContext = resolveCommandsContext(args, accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IListService));

		const groupContext = resolvedContext.groupedEditors[0];
		if (!groupContext) {
			return;
		}

		const editor = groupContext.editors[0];
		if (editor instanceof MultiDiffEditorInput) {
			const viewModel = await editor.getViewModel();
			viewModel.expandAll();
		}
	}
}
