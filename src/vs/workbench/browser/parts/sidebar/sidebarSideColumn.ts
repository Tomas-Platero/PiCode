/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';

/**
 * PiCode: the Agent layout splits the side bar in two once it is wide enough: a status column on
 * the side next to the chat, and the side bar's own view beside it. The side bar makes the room and
 * says so here; PiCode fills the column.
 */
/**
 * The side bar's own view container for that column: it is also one of the bar's tabs, so the panel
 * is still there when the bar is too narrow for two columns.
 */
export const PICODE_STATUS_CONTAINER_ID = 'workbench.view.picodeStatus';

export const SIDEBAR_SIDE_COLUMN_WIDTH = 280;

/** The side bar's width from which it splits: the column plus room for the view next to it. */
export const SIDEBAR_SIDE_COLUMN_MIN_WIDTH = 600;

class SidebarSideColumn {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private _element: HTMLElement | undefined;
	private _visible = false;

	get element(): HTMLElement | undefined { return this._element; }
	get visible(): boolean { return this._visible; }

	update(element: HTMLElement, visible: boolean): void {
		if (this._element === element && this._visible === visible) {
			return;
		}
		this._element = element;
		this._visible = visible;
		this._onDidChange.fire();
	}
}

export const sidebarSideColumn = new SidebarSideColumn();
