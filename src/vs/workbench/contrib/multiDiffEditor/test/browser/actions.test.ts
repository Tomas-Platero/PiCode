/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isISubmenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { PositionFileListLeftAction, PositionFileListRightAction, ToggleFileListAction, ViewFileListAsListAction, ViewFileListAsTreeAction } from '../../browser/actions.js';

suite('MultiDiffEditor Actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('groups the view modes and positions in the editor title overflow submenu', () => {
		const submenu = MenuRegistry.getMenuItems(MenuId.EditorTitle)
			.filter(isISubmenuItem)
			.find(item => item.submenu.id === 'MultiDiffEditorFilesViewAndPosition');
		assert.ok(submenu);
		const actions = [new ViewFileListAsListAction(), new ViewFileListAsTreeAction(), new PositionFileListLeftAction(), new PositionFileListRightAction()];
		const entries = actions.map(action => {
			const menu = action.desc.menu;
			assert.ok(menu && !Array.isArray(menu));
			const toggled = action.desc.toggled;
			return { id: action.desc.id, submenu: menu.id.id, group: menu.group, order: menu.order, toggled: toggled && (hasKey(toggled, { condition: true }) ? toggled.condition : toggled).serialize(), whenKeys: menu.when?.keys().sort(), preconditionKeys: action.desc.precondition?.keys().sort() };
		});
		const toggle = new ToggleFileListAction().desc;
		assert.ok(toggle.menu && !Array.isArray(toggle.menu));
		// Hidden where the editor has no file list, so a host's own entries are not shown next to disabled ones.
		const whenKeys = ['activeEditor', 'config.multiDiffEditor.experimental.fileList', 'multiDiffEditorFileListAvailable'];
		const preconditionKeys = ['activeEditor', 'config.multiDiffEditor.experimental.fileList', 'multiDiffEditorFileListAvailable'];
		assert.deepStrictEqual({ group: submenu.group, icon: toggle.icon, toggleOrder: toggle.menu.order, togglePreconditionKeys: toggle.precondition?.keys().sort(), entries }, {
			group: 'z_files',
			icon: { id: 'list-flat' },
			toggleOrder: 100001,
			togglePreconditionKeys: ['activeEditor', 'config.multiDiffEditor.experimental.fileList', 'isSessionsWindow', 'multiDiffEditorFileListAvailable'],
			entries: [
				{ id: 'multiDiffEditor.viewFileListAsList', submenu: submenu.submenu.id, group: '1_view', order: 1, toggled: 'multiDiffEditorFileListViewMode == \'list\'', whenKeys, preconditionKeys },
				{ id: 'multiDiffEditor.viewFileListAsTree', submenu: submenu.submenu.id, group: '1_view', order: 2, toggled: 'multiDiffEditorFileListViewMode == \'tree\'', whenKeys, preconditionKeys },
				{ id: 'multiDiffEditor.positionFileListLeft', submenu: submenu.submenu.id, group: '2_position', order: 1, toggled: 'multiDiffEditorFileListPosition == \'left\'', whenKeys, preconditionKeys },
				{ id: 'multiDiffEditor.positionFileListRight', submenu: submenu.submenu.id, group: '2_position', order: 2, toggled: 'multiDiffEditorFileListPosition == \'right\'', whenKeys, preconditionKeys },
			],
		});
	});
});
