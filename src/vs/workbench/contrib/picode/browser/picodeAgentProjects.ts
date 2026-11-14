/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { containsDragType, extractEditorsAndFilesDropData } from '../../../../platform/dnd/browser/dnd.js';
import { DataTransfers } from '../../../../base/browser/dnd.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';

const COLLAPSED_STORAGE_KEY = 'picode.sessions.projectsCollapsed';
const LOOKS_STORAGE_KEY = 'picode.sessions.projectLooks';

/** How a project is shown in the column; nothing here changes the folder or the workspace file. */
interface IProjectLook {
	readonly name?: string;
	readonly color?: string;
	readonly icon?: string;
}

/** Colours that read on dark and light themes alike. */
const PROJECT_COLORS: readonly string[] = ['#e5534b', '#e0823d', '#c69026', '#57ab5a', '#39c5cf', '#539bf5', '#986ee2', '#e275ad'];

/** Icons a project can wear. */
const PROJECT_ICONS: readonly ThemeIcon[] = [
	Codicon.folder, Codicon.globe, Codicon.server, Codicon.deviceMobile, Codicon.browser, Codicon.database, Codicon.package,
	Codicon.library, Codicon.book, Codicon.beaker, Codicon.rocket, Codicon.tools, Codicon.gear, Codicon.terminal,
	Codicon.code, Codicon.heart, Codicon.star, Codicon.flame, Codicon.cloud, Codicon.shield, Codicon.robot,
];

/**
 * The open projects, on top of the Agent layout's sessions column.
 *
 * The same folders the Explorer shows as the workspace's roots, so the column says what the chat is
 * working on without opening the Explorer: each folder is a row that reveals it, opens a terminal in
 * it or leaves the workspace, and new ones come in from the "+" button or by dropping folders on the
 * section. Adding a second folder to a folder window turns it into a workspace, as in the Explorer.
 */
export class PicodeAgentProjects extends Disposable {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	/** The section grew or shrank (a folder came or went, or it was folded): the list below re-lays out. */
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private readonly rowDisposables = this._register(new DisposableStore());
	private readonly element: HTMLElement;
	private readonly list: HTMLElement;
	private readonly count: HTMLElement;
	private collapsed: boolean;

	constructor(
		container: HTMLElement,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.collapsed = this.storageService.getBoolean(COLLAPSED_STORAGE_KEY, StorageScope.PROFILE, false);

		this.element = append(container, $('.picode-projects'));
		const header = append(this.element, $('.picode-projects-header'));
		const toggle = append(header, $('button.picode-projects-toggle', { type: 'button' }));
		const chevron = append(toggle, $('span.picode-projects-chevron'));
		append(toggle, $('span.picode-projects-title')).textContent = localize('picode.sessions.projects', "Projects");
		this.count = append(toggle, $('span.picode-projects-count'));
		const add = append(header, $(`button.picode-projects-add${ThemeIcon.asCSSSelector(Codicon.add)}`, { type: 'button' }));
		add.title = localize('picode.sessions.addProject', "Add a project to this workspace");
		add.setAttribute('aria-label', add.title);
		this.list = append(this.element, $('.picode-projects-list'));

		const paintCollapsed = () => {
			this.element.classList.toggle('collapsed', this.collapsed);
			chevron.className = `picode-projects-chevron ${ThemeIcon.asClassName(this.collapsed ? Codicon.chevronRight : Codicon.chevronDown)}`;
			toggle.setAttribute('aria-expanded', String(!this.collapsed));
		};
		paintCollapsed();
		this._register(addDisposableListener(toggle, EventType.CLICK, () => {
			this.collapsed = !this.collapsed;
			this.storageService.store(COLLAPSED_STORAGE_KEY, this.collapsed, StorageScope.PROFILE, StorageTarget.USER);
			paintCollapsed();
			this._onDidChangeHeight.fire();
		}));
		this._register(addDisposableListener(add, EventType.CLICK, () => void this.addProject()));

		this.registerDrop();
		this.render();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.render()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => this.render()));
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, LOOKS_STORAGE_KEY, this._store)(() => this.render()));
	}

	private looks(): Record<string, IProjectLook> {
		try {
			const parsed = JSON.parse(this.storageService.get(LOOKS_STORAGE_KEY, StorageScope.PROFILE, '{}'));
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}

	private lookOf(uri: URI): IProjectLook {
		return this.looks()[uri.toString()] ?? {};
	}

	private setLook(uri: URI, change: IProjectLook): void {
		const all = this.looks();
		const next: Record<string, string | undefined> = { ...all[uri.toString()], ...change };
		for (const key of Object.keys(next)) {
			if (!next[key]) {
				delete next[key];
			}
		}
		if (Object.keys(next).length === 0) {
			delete all[uri.toString()];
		} else {
			all[uri.toString()] = next;
		}
		this.storageService.store(LOOKS_STORAGE_KEY, JSON.stringify(all), StorageScope.PROFILE, StorageTarget.USER);
	}

	private render(): void {
		this.rowDisposables.clear();
		clearNode(this.list);
		const folders = this.workspaceService.getWorkspace().folders;
		this.count.textContent = folders.length > 0 ? String(folders.length) : '';

		if (folders.length === 0) {
			const empty = append(this.list, $('button.picode-projects-row.empty', { type: 'button' }));
			append(empty, $(`span.picode-projects-icon${ThemeIcon.asCSSSelector(Codicon.folderOpened)}`));
			append(empty, $('span.picode-projects-name')).textContent = localize('picode.sessions.openFolder', "Open a folder");
			this.rowDisposables.add(addDisposableListener(empty, EventType.CLICK, () => void this.commandService.executeCommand('workbench.action.files.openFolder')));
		}

		// Two folders with the same name are told apart by the folder they sit in.
		const names = new Map<string, number>();
		for (const folder of folders) {
			names.set(folder.name, (names.get(folder.name) ?? 0) + 1);
		}
		folders.forEach((folder, index) => this.renderRow(folder, index, folders.length, (names.get(folder.name) ?? 0) > 1));
		this._onDidChangeHeight.fire();
	}

	private renderRow(folder: IWorkspaceFolder, index: number, count: number, showParent: boolean): void {
		const look = this.lookOf(folder.uri);
		const label = look.name || folder.name;
		const row = append(this.list, $('.picode-projects-row', { role: 'button', tabIndex: 0 }));
		row.setAttribute('aria-label', label);
		if (look.color) {
			row.style.setProperty('--picode-project-color', look.color);
			row.classList.add('colored');
		}
		const icon = PROJECT_ICONS.find(candidate => candidate.id === look.icon) ?? Codicon.folder;
		append(row, $(`span.picode-projects-icon${ThemeIcon.asCSSSelector(icon)}`));
		append(row, $('span.picode-projects-name')).textContent = label;
		if (look.name && look.name !== folder.name) {
			row.title = folder.name;
		}
		if (showParent) {
			append(row, $('span.picode-projects-parent')).textContent = basename(dirname(folder.uri));
		}

		const actions = append(row, $('.picode-projects-row-actions'));
		const rowAction = (icon: ThemeIcon, label: string, run: () => unknown) => {
			const button = append(actions, $(`button.picode-projects-row-action${ThemeIcon.asCSSSelector(icon)}`, { type: 'button' }));
			button.title = label;
			button.setAttribute('aria-label', label);
			this.rowDisposables.add(addDisposableListener(button, EventType.CLICK, e => {
				e.stopPropagation();
				void run();
			}));
		};
		rowAction(Codicon.terminal, localize('picode.sessions.projectTerminal', "Open in Terminal"), () => this.openTerminal(folder.uri));
		rowAction(Codicon.close, localize('picode.sessions.projectRemove', "Remove from Workspace"), () => this.remove(folder.uri));

		this.rowDisposables.add(addDisposableListener(row, EventType.CLICK, () => void this.reveal(folder.uri)));
		this.rowDisposables.add(addDisposableListener(row, EventType.DBLCLICK, e => {
			e.preventDefault();
			this.customize(folder, row);
		}));
		this.rowDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				void this.reveal(folder.uri);
			} else if (e.key === 'F2') {
				e.preventDefault();
				this.customize(folder, row);
			} else if (e.key === 'Delete') {
				e.preventDefault();
				void this.remove(folder.uri);
			}
		}));
		this.rowDisposables.add(addDisposableListener(row, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			e.preventDefault();
			const event = new StandardMouseEvent(row.ownerDocument.defaultView!, e);
			this.contextMenuService.showContextMenu({
				getAnchor: () => event,
				getActions: () => [
					new Action('picode.projects.reveal', localize('picode.sessions.projectReveal', "Show in Explorer"), undefined, true, () => this.reveal(folder.uri)),
					new Action('picode.projects.terminal', localize('picode.sessions.projectTerminal', "Open in Terminal"), undefined, true, () => this.openTerminal(folder.uri)),
					new Action('picode.projects.copy', localize('picode.sessions.projectCopyPath', "Copy Path"), undefined, true, () => this.clipboardService.writeText(folder.uri.fsPath)),
					new Separator(),
					new Action('picode.projects.customize', localize('picode.sessions.projectCustomize', "Customize…"), undefined, true, async () => this.customize(folder, row)),
					new Action('picode.projects.up', localize('picode.sessions.projectMoveUp', "Move Up"), undefined, index > 0, () => this.move(index, -1)),
					new Action('picode.projects.down', localize('picode.sessions.projectMoveDown', "Move Down"), undefined, index < count - 1, () => this.move(index, 1)),
					new Separator(),
					new Action('picode.projects.add', localize('picode.sessions.addProjectShort', "Add Project…"), undefined, true, () => this.addProject()),
					new Action('picode.projects.remove', localize('picode.sessions.projectRemove', "Remove from Workspace"), undefined, true, () => this.remove(folder.uri)),
				],
			});
		}));
	}

	/** Folders dragged from the system or the Explorer join the workspace when dropped on the section. */
	private registerDrop(): void {
		let depth = 0;
		const accepts = (e: DragEvent) => containsDragType(e, DataTransfers.FILES, DataTransfers.RESOURCES, 'CodeFiles');
		this._register(addDisposableListener(this.element, EventType.DRAG_ENTER, (e: DragEvent) => {
			if (accepts(e)) {
				depth++;
				this.element.classList.add('drop-target');
			}
		}));
		this._register(addDisposableListener(this.element, EventType.DRAG_OVER, (e: DragEvent) => {
			if (accepts(e)) {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'copy';
				}
			}
		}));
		this._register(addDisposableListener(this.element, EventType.DRAG_LEAVE, () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) {
				this.element.classList.remove('drop-target');
			}
		}));
		this._register(addDisposableListener(this.element, EventType.DROP, async (e: DragEvent) => {
			depth = 0;
			this.element.classList.remove('drop-target');
			if (!accepts(e)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const dropped = await this.instantiationService.invokeFunction(accessor => extractEditorsAndFilesDropData(accessor, e));
			const open = new Set(this.workspaceService.getWorkspace().folders.map(folder => folder.uri.toString()));
			const folders: URI[] = [];
			for (const item of dropped) {
				if (!item.resource || open.has(item.resource.toString())) {
					continue;
				}
				try {
					const stat = await this.fileService.stat(item.resource);
					if (stat.isDirectory) {
						folders.push(stat.resource);
					}
				} catch {
					// Gone or unreadable: nothing to add.
				}
			}
			if (folders.length > 0) {
				await this.workspaceEditingService.addFolders(folders.map(uri => ({ uri })));
			}
		}));
	}

	/** Swaps a project with its neighbour; the first one is where the chat starts. */
	private async move(index: number, step: -1 | 1): Promise<void> {
		const folders = this.workspaceService.getWorkspace().folders.map(folder => ({ uri: folder.uri, name: folder.name }));
		const target = index + step;
		if (target < 0 || target >= folders.length) {
			return;
		}
		[folders[index], folders[target]] = [folders[target], folders[index]];
		await this.workspaceEditingService.updateFolders(0, folders.length, folders);
	}

	/** A small window beside the row: the name shown here, a colour and an icon. */
	private customize(folder: IWorkspaceFolder, anchor: HTMLElement): void {
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			render: container => this.renderCustomizer(container, folder),
		});
	}

	private renderCustomizer(container: HTMLElement, folder: IWorkspaceFolder): IDisposable {
		const store = new DisposableStore();
		const look = this.lookOf(folder.uri);
		const panel = append(container, $('.picode-projects-customizer'));
		const close = () => this.contextViewService.hideContextView();

		append(panel, $('.picode-projects-customizer-title')).textContent = localize('picode.sessions.projectCustomizeTitle', "Customize project");

		const preview = append(panel, $('.picode-projects-customizer-preview'));
		const previewIcon = append(preview, $('span'));
		const previewName = append(preview, $('span.picode-projects-name'));
		let color = look.color;
		let icon = PROJECT_ICONS.find(candidate => candidate.id === look.icon) ?? Codicon.folder;

		append(panel, $('label.picode-projects-customizer-label')).textContent = localize('picode.sessions.projectName', "Name");
		const input = append(panel, $('input.picode-projects-customizer-input', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
		input.value = look.name ?? folder.name;
		input.placeholder = folder.name;

		const paintPreview = () => {
			previewIcon.className = ThemeIcon.asClassName(icon);
			previewIcon.style.color = color ?? '';
			previewName.textContent = input.value.trim() || folder.name;
		};
		const commitName = () => {
			const name = input.value.trim();
			this.setLook(folder.uri, { name: name && name !== folder.name ? name : undefined });
		};
		store.add(addDisposableListener(input, EventType.INPUT, paintPreview));
		store.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commitName();
				close();
			}
		}));

		append(panel, $('label.picode-projects-customizer-label')).textContent = localize('picode.sessions.projectColor', "Colour");
		const swatches = append(panel, $('.picode-projects-customizer-swatches'));
		const swatchButtons: HTMLElement[] = [];
		const paintSwatches = () => swatchButtons.forEach(button => button.classList.toggle('selected', (button.dataset.color || undefined) === color));
		for (const value of [undefined, ...PROJECT_COLORS]) {
			const button = append(swatches, $('button.picode-projects-swatch', { type: 'button' }));
			button.dataset.color = value ?? '';
			if (value) {
				button.style.background = value;
			} else {
				button.classList.add('none');
				button.title = localize('picode.sessions.projectNoColor', "No colour");
			}
			swatchButtons.push(button);
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				color = value;
				this.setLook(folder.uri, { color: value });
				paintSwatches();
				paintPreview();
			}));
		}

		append(panel, $('label.picode-projects-customizer-label')).textContent = localize('picode.sessions.projectIcon', "Icon");
		const icons = append(panel, $('.picode-projects-customizer-icons'));
		const iconButtons: HTMLElement[] = [];
		const paintIcons = () => iconButtons.forEach(button => button.classList.toggle('selected', button.dataset.icon === icon.id));
		for (const candidate of PROJECT_ICONS) {
			const button = append(icons, $(`button.picode-projects-icon-choice${ThemeIcon.asCSSSelector(candidate)}`, { type: 'button' }));
			button.dataset.icon = candidate.id;
			iconButtons.push(button);
			store.add(addDisposableListener(button, EventType.CLICK, () => {
				icon = candidate;
				this.setLook(folder.uri, { icon: candidate.id === Codicon.folder.id ? undefined : candidate.id });
				paintIcons();
				paintPreview();
			}));
		}

		const footer = append(panel, $('.picode-projects-customizer-footer'));
		const reset = append(footer, $('button.picode-projects-customizer-reset', { type: 'button' }));
		reset.textContent = localize('picode.sessions.projectReset', "Reset");
		store.add(addDisposableListener(reset, EventType.CLICK, () => {
			const all = this.looks();
			delete all[folder.uri.toString()];
			this.storageService.store(LOOKS_STORAGE_KEY, JSON.stringify(all), StorageScope.PROFILE, StorageTarget.USER);
			close();
		}));
		const done = append(footer, $('button.picode-projects-customizer-done', { type: 'button' }));
		done.textContent = localize('picode.sessions.projectDone', "Done");
		store.add(addDisposableListener(done, EventType.CLICK, () => {
			commitName();
			close();
		}));

		// A click outside, or Escape, closes it; the name typed so far is kept.
		const targetWindow = container.ownerDocument.defaultView!;
		store.add(addDisposableListener(targetWindow, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (!panel.contains(e.target as Node)) {
				commitName();
				close();
			}
		}, true));
		store.add(addDisposableListener(panel, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				close();
			}
		}));

		paintSwatches();
		paintIcons();
		paintPreview();
		store.add(toDisposable(() => panel.remove()));
		const focus = setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
		store.add(toDisposable(() => clearTimeout(focus)));
		return store;
	}


	private addProject(): Promise<unknown> {
		return this.commandService.executeCommand('addRootFolder');
	}

	private reveal(uri: URI): Promise<unknown> {
		return this.commandService.executeCommand('revealInExplorer', uri);
	}

	private openTerminal(uri: URI): Promise<unknown> {
		return this.commandService.executeCommand('openInIntegratedTerminal', uri);
	}

	private remove(uri: URI): Promise<void> {
		return this.workspaceEditingService.removeFolders([uri]);
	}
}
