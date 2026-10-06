/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, isDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer, IListContextMenuEvent } from '../../../../../base/browser/ui/list/list.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Button, ButtonWithDropdown } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { autorun, runOnChange } from '../../../../../base/common/observable.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Delayer } from '../../../../../base/common/async.js';
import { Action, IAction, Separator } from '../../../../../base/common/actions.js';
import { basename, dirname, isEqual } from '../../../../../base/common/resources.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { IAgentPlugin, IAgentPluginService } from '../../common/plugins/agentPluginService.js';
import { isContributionEnabled } from '../../common/enablement.js';
import { getInstalledPluginContextMenuActions } from '../agentPluginActions.js';
import { IMarketplacePlugin, IPluginMarketplaceService, MarketplaceType, PluginSourceKind } from '../../common/plugins/pluginMarketplaceService.js';
import { IMarketplaceReference, MarketplaceReferenceKind } from '../../common/plugins/marketplaceReference.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IPluginInstallService } from '../../common/plugins/pluginInstallService.js';
import { AgentPluginItemKind, IAgentPluginItem, IInstalledPluginItem, IMarketplacePluginItem } from '../agentPluginEditor/agentPluginItems.js';
import { pluginIcon } from './aiCustomizationIcons.js';
import { formatDisplayName, truncateToFirstLine } from './aiCustomizationListWidget.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { CustomizationGroupHeaderRenderer, ICustomizationGroupHeaderEntry, CUSTOMIZATION_GROUP_HEADER_HEIGHT, CUSTOMIZATION_GROUP_HEADER_HEIGHT_WITH_SEPARATOR } from './customizationGroupHeaderRenderer.js';
import { getCustomizationDisabledLabel, ICustomizationHarnessService, isPluginCustomizationItem, type ICustomizationItem, type ICustomizationItemAction } from '../../common/customizationHarnessService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../common/constants.js';
import { IAICustomizationItemsModel } from './aiCustomizationItemsModel.js';
import { GalleryItemInstallState, GalleryItemRenderer, IGalleryItemProvider } from './galleryItemRenderer.js';
import { UpdateAgentPluginsCommandId } from '../chat.js';

const $ = DOM.$;

const PLUGIN_ITEM_HEIGHT = 36;

/** A table row carries two buttons, so it is a little taller than a plain item row. */
const PI_PACKAGE_ROW_HEIGHT = 44;

/** Row shape returned by the PiCode package catalog connector (`picode.packages.search`). */
interface IPackageCatalogRow {
	readonly name: string;
	readonly description?: string;
	readonly publisher?: string;
	readonly version?: string;
}

/** Result shape returned by the PiCode package installer connector (`picode.packages.install`). */
interface IPackageInstallResult {
	readonly ok: boolean;
	readonly message: string;
}

const PACKAGES_SEARCH_COMMAND = 'picode.packages.search';
const PACKAGES_INSTALL_COMMAND = 'picode.packages.install';

/** The listing command: what is installed, each row carrying its source, state and scope. */
const PACKAGES_LIST_COMMAND = 'picode.setup.packages';

/** The management commands the installed table's actions invoke; the connector performs. */
const PACKAGES_DISABLE_COMMAND = 'picode.packages.disable';
const PACKAGES_ENABLE_COMMAND = 'picode.packages.enable';
const PACKAGES_UNINSTALL_COMMAND = 'picode.packages.uninstall';
const PACKAGES_UPDATES_CHECK_COMMAND = 'picode.packages.updatesCheck';
const PACKAGES_UPDATE_COMMAND = 'picode.packages.update';

/** Result shape returned by the PiCode package disable/enable/uninstall/update connectors. */
interface IPiPackageRow {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly path: string;
	/** The declaration as pi's settings spell it (`npm:pi-lens`), when one exists. */
	readonly source?: string;
	readonly state?: 'enabled' | 'disabled';
	/** Where the declaration was found: the user profile, or a workspace's `.pi`. */
	readonly scope?: 'user' | 'workspace';
	/** The update check's answer for this row, merged in after the table has rendered. */
	readonly update?: IPiPackageUpdateStatus;
}

/** One row's update status, as the connector's check command answers it. */
interface IPiPackageUpdateStatus {
	readonly state: 'uncheckable' | 'unknown' | 'current' | 'behind';
	/** The newer version npm knows, when the row is behind. */
	readonly latest?: string;
	/** Why the row says nothing actionable, for `uncheckable` and `unknown`. */
	readonly reason?: string;
}

/** One row of the connector's check answer, keyed back to the row that asked. */
interface IPiPackageUpdateStatusRow extends IPiPackageUpdateStatus {
	readonly path: string;
	readonly name: string;
}

//#region Entry types

/**
 * Represents a collapsible group header in the plugin list.
 */
interface IPluginGroupHeaderEntry extends ICustomizationGroupHeaderEntry {
	readonly group: string;
}

/**
 * Represents an installed plugin item in the list.
 */
interface IPluginInstalledItemEntry {
	readonly type: 'plugin-item';
	readonly item: IInstalledPluginItem;
}

/**
 * Represents a marketplace plugin item in the list (browse mode).
 */
interface IPluginMarketplaceItemEntry {
	readonly type: 'marketplace-item';
	readonly item: IMarketplacePluginItem;
}

interface IPluginRemoteItemEntry {
	readonly type: 'remote-item';
	readonly item: ICustomizationItem;
}

/**
 * Represents one installed pi package in the installed list, presented as a table row
 * (see {@link PluginPiPackageRowRenderer}).
 */
interface IPluginPiPackageItemEntry {
	readonly type: 'pi-package-item';
	readonly row: IPiPackageRow;
}

type IPluginListEntry = IPluginGroupHeaderEntry | IPluginInstalledItemEntry | IPluginMarketplaceItemEntry | IPluginRemoteItemEntry | IPluginPiPackageItemEntry;

//#endregion

//#region Delegate

class PluginItemDelegate implements IListVirtualDelegate<IPluginListEntry> {
	getHeight(element: IPluginListEntry): number {
		if (element.type === 'group-header') {
			return element.isFirst ? CUSTOMIZATION_GROUP_HEADER_HEIGHT : CUSTOMIZATION_GROUP_HEADER_HEIGHT_WITH_SEPARATOR;
		}
		if (element.type === 'marketplace-item') {
			return 62;
		}
		if (element.type === 'pi-package-item') {
			return PI_PACKAGE_ROW_HEIGHT;
		}
		return PLUGIN_ITEM_HEIGHT;
}

	getTemplateId(element: IPluginListEntry): string {
		if (element.type === 'group-header') {
			return 'pluginGroupHeader';
		}
		if (element.type === 'marketplace-item') {
			return PLUGIN_MARKETPLACE_ITEM_TEMPLATE_ID;
		}
		if (element.type === 'remote-item') {
			return 'pluginRemoteItem';
		}
		if (element.type === 'pi-package-item') {
			return PI_PACKAGE_ITEM_TEMPLATE_ID;
		}
		return 'pluginInstalledItem';
	}
}

//#endregion

//#endregion

//#region Installed Plugin Renderer (reuses .mcp-server-item CSS)

interface IPluginInstalledItemTemplateData {
	readonly container: HTMLElement;
	readonly typeIcon: HTMLElement;
	readonly name: HTMLElement;
	readonly description: HTMLElement;
	readonly disposables: DisposableStore;
}

class PluginInstalledItemRenderer implements IListRenderer<IPluginInstalledItemEntry, IPluginInstalledItemTemplateData> {
	readonly templateId = 'pluginInstalledItem';

	renderTemplate(container: HTMLElement): IPluginInstalledItemTemplateData {
		container.classList.add('mcp-server-item');

		const typeIcon = DOM.append(container, $('.mcp-server-icon'));
		typeIcon.classList.add(...ThemeIcon.asClassNameArray(pluginIcon));

		const details = DOM.append(container, $('.mcp-server-details'));
		const name = DOM.append(details, $('.mcp-server-name'));
		const description = DOM.append(details, $('.mcp-server-description'));

		return { container, typeIcon, name, description, disposables: new DisposableStore() };
	}

	renderElement(element: IPluginInstalledItemEntry, _index: number, templateData: IPluginInstalledItemTemplateData): void {
		templateData.disposables.clear();

		templateData.name.textContent = formatDisplayName(element.item.name);

		if (element.item.description) {
			templateData.description.textContent = truncateToFirstLine(element.item.description);
			templateData.description.style.display = '';
		} else {
			templateData.description.style.display = 'none';
		}

		// Reflect enabled/disabled state on the container for visual styling. The
		// inline status badge ("Enabled"/"Disabled") is intentionally omitted —
		// items are already grouped under "Enabled Locally" / "Disabled Locally"
		// section headers, and the row's aria-label conveys state to screen readers.
		templateData.disposables.add(autorun(reader => {
			const enabled = isContributionEnabled(element.item.plugin.enablement.read(reader));
			templateData.container.classList.toggle('disabled', !enabled);
		}));

	}

	disposeTemplate(templateData: IPluginInstalledItemTemplateData): void {
		templateData.disposables.dispose();
	}
}

//#endregion

//#region Pi Package Table Row Renderer

const PI_PACKAGE_ITEM_TEMPLATE_ID = 'pluginPiPackageItem';

interface IPluginPiPackageRowTemplateData {
	readonly container: HTMLElement;
	readonly name: HTMLElement;
	readonly version: HTMLElement;
	readonly source: HTMLElement;
	readonly stateText: HTMLElement;
	readonly updateHint: HTMLElement;
	readonly toggleButton: Button;
	readonly updateButton: Button;
	readonly uninstallButton: Button;
	readonly hint: HTMLElement;
	readonly disposables: DisposableStore;
}

/**
 * One installed pi package as a table row: Name · Version · Source · State · Actions.
 *
 * The actions edit pi's own settings through the connector — Disable/Enable toggles the
 * declaration, Uninstall removes it with pi — so a row without a declaration (a package the
 * disk scan found without pi's settings spelling it) renders without buttons: there is no
 * spelling for the actions to act on.
 */
class PluginPiPackageRowRenderer implements IListRenderer<IPluginPiPackageItemEntry, IPluginPiPackageRowTemplateData> {
	readonly templateId = PI_PACKAGE_ITEM_TEMPLATE_ID;

	constructor(
		private readonly onToggle: (row: IPiPackageRow) => void,
		private readonly onUninstall: (row: IPiPackageRow) => void,
		private readonly onUpdate: (row: IPiPackageRow) => void,
	) { }

	renderTemplate(container: HTMLElement): IPluginPiPackageRowTemplateData {
		container.classList.add('pi-package-row');

		const name = DOM.append(container, $('.pi-package-row-name'));
		const version = DOM.append(container, $('.pi-package-row-version'));
		const source = DOM.append(container, $('.pi-package-row-source'));
		const state = DOM.append(container, $('.pi-package-row-state'));
		const stateText = DOM.append(state, $('.pi-package-row-state-text'));
		const updateHint = DOM.append(state, $('.pi-package-row-update'));
		const actions = DOM.append(container, $('.pi-package-row-actions'));

		const toggleButton = new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true });
		toggleButton.element.classList.add('pi-package-row-action');
		const updateTooltip = localize('updatePackageTooltip', "Update the package to the newest version npm knows");
		const updateButton = new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: updateTooltip, ariaLabel: updateTooltip });
		updateButton.label = `$(${Codicon.arrowUp.id}) ${localize('updatePackageAction', "Update")}`;
		updateButton.element.classList.add('pi-package-row-action');
		const uninstallTooltip = localize('uninstallPackageTooltip', "Remove the package from pi's settings");
		const uninstallButton = new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: uninstallTooltip, ariaLabel: uninstallTooltip });
		uninstallButton.label = `$(${Codicon.trash.id})`;
		uninstallButton.element.classList.add('pi-package-row-action');
		const hint = DOM.append(actions, $('.pi-package-row-hint'));
		hint.style.display = 'none';

		return { container, name, version, source, stateText, updateHint, toggleButton, updateButton, uninstallButton, hint, disposables: new DisposableStore() };
	}

	renderElement(element: IPluginPiPackageItemEntry, _index: number, templateData: IPluginPiPackageRowTemplateData): void {
		templateData.disposables.clear();
		const { row } = element;
		templateData.name.textContent = formatDisplayName(row.name);
		templateData.name.title = truncateToFirstLine(row.description ?? '');
		templateData.version.textContent = row.version ?? '';
		templateData.source.textContent = row.source ?? '';
		templateData.source.title = row.source ?? '';
		const disabled = row.state === 'disabled';
		const declared = row.source !== undefined;
		templateData.stateText.textContent = disabled
			? localize('packageStateDisabled', "Disabled")
			: declared
				? localize('packageStateEnabled', "Enabled")
				: localize('packageStateNotDeclared', "Not declared");
		templateData.stateText.classList.toggle('disabled', disabled);
		templateData.container.classList.toggle('disabled', disabled);

		// The update check's answer, said in the row's own voice: a row that is behind says what
		// it is behind to (with the action that takes it there); a row that cannot be checked
		// says so instead of pretending; a row that is current says nothing at all.
		const update = row.update;
		if (!disabled && update?.state === 'behind' && update.latest) {
			templateData.updateHint.textContent = localize('packageUpdateBehind', "Update to {0} available", update.latest);
			templateData.updateHint.title = localize('packageUpdateBehindTitle', "Now {0}", row.version ?? '?');
			templateData.updateHint.style.display = '';
			templateData.updateHint.classList.add('behind');
		} else if (!disabled && row.source !== undefined && (update?.state === 'uncheckable' || update?.state === 'unknown')) {
			templateData.updateHint.textContent = localize('packageUpdateCannotCheck', "Cannot check for updates");
			templateData.updateHint.title = update.reason ?? '';
			templateData.updateHint.style.display = '';
			templateData.updateHint.classList.remove('behind');
		} else {
			templateData.updateHint.style.display = 'none';
			templateData.updateHint.textContent = '';
			templateData.updateHint.title = '';
			templateData.updateHint.classList.remove('behind');
		}
		templateData.updateButton.element.style.display = !disabled && row.source !== undefined && update?.state === 'behind' ? '' : 'none';

		if (row.source === undefined) {
			// A package the disk scan found without pi's settings spelling it: pi never loads
			// it, and there is no spelling for the actions to act on — say so instead of
			// leaving an empty cell.
			templateData.toggleButton.element.style.display = 'none';
			templateData.uninstallButton.element.style.display = 'none';
			templateData.hint.style.display = '';
			templateData.hint.textContent = localize('packageNotDeclaredHint', "Installed on disk; pi does not load it. Reinstall it to manage it here.");
			return;
		}
		templateData.toggleButton.element.style.display = '';
		templateData.uninstallButton.element.style.display = '';
		templateData.hint.style.display = 'none';
		if (disabled) {
			templateData.toggleButton.label = `$(${Codicon.play.id}) ${localize('enablePackageAction', "Enable")}`;
			templateData.toggleButton.setTitle(localize('enablePackageTooltip', "Pi loads this package again"));
		} else {
			templateData.toggleButton.label = `$(${Codicon.debugPause.id}) ${localize('disablePackageAction', "Disable")}`;
			templateData.toggleButton.setTitle(localize('disablePackageTooltip', "Pi stops loading this package. Its files stay on disk."));
		}
		templateData.disposables.add(templateData.toggleButton.onDidClick(() => this.onToggle(row)));
		templateData.disposables.add(templateData.updateButton.onDidClick(() => this.onUpdate(row)));
		templateData.disposables.add(templateData.uninstallButton.onDidClick(() => this.onUninstall(row)));
	}

	disposeTemplate(templateData: IPluginPiPackageRowTemplateData): void {
		templateData.disposables.dispose();
		templateData.toggleButton.dispose();
		templateData.updateButton.dispose();
		templateData.uninstallButton.dispose();
	}
}

//#endregion

//#region Remote Plugin Renderer

interface IPluginRemoteItemTemplateData {
	readonly container: HTMLElement;
	readonly typeIcon: HTMLElement;
	readonly name: HTMLElement;
	readonly badge: HTMLElement;
	readonly description: HTMLElement;
	readonly status: HTMLElement;
}

class PluginRemoteItemRenderer implements IListRenderer<IPluginRemoteItemEntry, IPluginRemoteItemTemplateData> {
	readonly templateId = 'pluginRemoteItem';

	renderTemplate(container: HTMLElement): IPluginRemoteItemTemplateData {
		container.classList.add('mcp-server-item');

		const typeIcon = DOM.append(container, $('.mcp-server-icon'));
		typeIcon.classList.add(...ThemeIcon.asClassNameArray(pluginIcon));

		const details = DOM.append(container, $('.mcp-server-details'));
		const nameRow = DOM.append(details, $('.mcp-server-name'));
		const name = DOM.append(nameRow, $('span'));
		const badge = DOM.append(nameRow, $('.inline-badge.item-badge'));
		const description = DOM.append(details, $('.mcp-server-description'));
		const status = DOM.append(container, $('.mcp-server-status'));

		return { container, typeIcon, name, badge, description, status };
	}

	renderElement(element: IPluginRemoteItemEntry, _index: number, templateData: IPluginRemoteItemTemplateData): void {
		templateData.name.textContent = formatDisplayName(element.item.name);

		if (element.item.badge) {
			templateData.badge.textContent = element.item.badge;
			templateData.badge.style.display = '';
			templateData.badge.title = element.item.badgeTooltip ?? '';
		} else {
			templateData.badge.textContent = '';
			templateData.badge.style.display = 'none';
			templateData.badge.title = '';
		}

		if (element.item.description) {
			templateData.description.textContent = truncateToFirstLine(element.item.description);
			templateData.description.style.display = '';
		} else {
			templateData.description.textContent = '';
			templateData.description.style.display = 'none';
		}

		templateData.container.classList.toggle('disabled', element.item.enabled === false);
		templateData.status.className = 'mcp-server-status';
		if (element.item.enabled === false) {
			templateData.status.textContent = getRemotePluginDisabledLabel(element.item);
			templateData.status.classList.add('disabled');
			return;
		}

		switch (element.item.status) {
			case 'loading':
				templateData.status.textContent = localize('remotePluginLoading', "Loading");
				templateData.status.classList.add('running');
				break;
			case 'loaded':
				templateData.status.textContent = localize('remotePluginLoaded', "Loaded");
				templateData.status.classList.add('running');
				break;
			case 'degraded':
				templateData.status.textContent = localize('remotePluginDegraded', "Warning");
				templateData.status.classList.add('disabled');
				break;
			case 'error':
				templateData.status.textContent = localize('remotePluginError', "Error");
				templateData.status.classList.add('disabled');
				break;
			default:
				templateData.status.textContent = '';
				break;
		}
	}

	disposeTemplate(_templateData: IPluginRemoteItemTemplateData): void { }
}

export function getRemotePluginDisabledLabel(item: Pick<ICustomizationItem, 'disabledReason'>): string {
	return getCustomizationDisabledLabel(item.disabledReason);
}

//#endregion

//#region Marketplace Plugin Renderer

const PLUGIN_MARKETPLACE_ITEM_TEMPLATE_ID = 'pluginMarketplaceItem';

/** Adapts a marketplace plugin entry to the shared gallery row renderer. */
class PluginMarketplaceItemProvider implements IGalleryItemProvider<IPluginMarketplaceItemEntry> {

	constructor(
		private readonly pluginInstallService: IPluginInstallService,
		private readonly agentPluginService: IAgentPluginService,
		private readonly commandService: ICommandService,
		private readonly dialogService: IDialogService,
		private readonly onPackageInstalled: () => void,
	) { }

	getLabel(element: IPluginMarketplaceItemEntry): string {
		return element.item.name;
	}

	getPublisherDisplayName(element: IPluginMarketplaceItemEntry): string | undefined {
		return element.item.marketplace;
	}

	getDescription(element: IPluginMarketplaceItemEntry): string | undefined {
		return element.item.description;
	}

	getInstallState(element: IPluginMarketplaceItemEntry): GalleryItemInstallState {
		const installUri = this.pluginInstallService.getPluginInstallUri(this._toInstallable(element.item));
		const isInstalled = this.agentPluginService.plugins.get().some(p => isEqual(p.uri, installUri));
		return isInstalled ? GalleryItemInstallState.Installed : GalleryItemInstallState.Uninstalled;
	}

	async install(element: IPluginMarketplaceItemEntry): Promise<void> {
		await installPackageViaConnector(
			this.commandService,
			this.dialogService,
			`npm:${element.item.name}`,
			element.item.name,
			this.onPackageInstalled,
		);
	}

	onDidChangeInstallState(_element: IPluginMarketplaceItemEntry, listener: () => void) {
		return runOnChange(this.agentPluginService.plugins, () => listener());
	}

	private _toInstallable(item: IMarketplacePluginItem) {
		return {
			name: item.name,
			description: item.description,
			version: '',
			sourceDescriptor: item.sourceDescriptor,
			source: item.source,
			marketplace: item.marketplace,
			marketplaceReference: item.marketplaceReference,
			marketplaceType: item.marketplaceType,
		};
	}
}

//#endregion
//#region Helpers

function marketplacePluginToItem(plugin: IMarketplacePlugin): IMarketplacePluginItem {
	return {
		kind: AgentPluginItemKind.Marketplace,
		name: plugin.name,
		description: plugin.description,
		source: plugin.source,
		sourceDescriptor: plugin.sourceDescriptor,
		marketplace: plugin.marketplace,
		marketplaceReference: plugin.marketplaceReference,
		marketplaceType: plugin.marketplaceType,
		readmeUri: plugin.readmeUri,
	};
}

/**
 * Maps a package catalog row to the marketplace item shape used by the browse list.
 * The synthetic npm reference is never cloned or resolved locally; installs go through
 * the PiCode connector (`picode.packages.install`) and discovery refreshes separately.
 */
function npmPackageToMarketplacePlugin(row: IPackageCatalogRow): IMarketplacePlugin {
	const marketplaceReference: IMarketplaceReference = {
		rawValue: `npm:${row.name}`,
		displayLabel: row.name,
		cloneUrl: '',
		canonicalId: `npm:${row.name}`,
		cacheSegments: ['npm', row.name],
		kind: MarketplaceReferenceKind.GitUri,
	};
	return {
		name: row.name,
		description: row.description ?? '',
		version: row.version ?? '',
		source: 'npm',
		sourceDescriptor: { kind: PluginSourceKind.Npm, package: row.name },
		marketplace: 'npm',
		marketplaceReference,
		marketplaceType: MarketplaceType.OpenPlugin,
	};
}

/**
 * Installs a package through the PiCode connector and reports the outcome.
 * On success the plugin discovery is refreshed and {@link onInstalled} runs so the
 * caller can return to the installed list. On connector absence the user is pointed
 * at the pi CLI instead of a generic failure.
 */
async function installPackageViaConnector(
	commandService: ICommandService,
	dialogService: IDialogService,
	installTarget: string,
	displayName: string,
	onInstalled: () => void,
): Promise<void> {
	let result: IPackageInstallResult | undefined;
	try {
		result = await commandService.executeCommand<IPackageInstallResult>(PACKAGES_INSTALL_COMMAND, installTarget);
	} catch {
		await dialogService.warn(localize('packagesConnectorUnavailableInstall', "PiCode connector is unavailable — packages are installed from the pi CLI."));
		return;
	}
	if (result?.ok) {
		await dialogService.info(localize('packageInstalled', "Package {0} installed. It will appear in the list.", displayName));
		await commandService.executeCommand(UpdateAgentPluginsCommandId);
		onInstalled();
	} else {
		await dialogService.warn(result?.message || localize('packageInstallFailed', "Package installation failed."));
	}
}

function installedPluginToItem(plugin: IAgentPlugin, labelService: ILabelService): IInstalledPluginItem {
	// Use `||` (not `??`) so an empty `label` also falls back to the URI basename.
	// The items model's `getPluginCount` dedupes against this same fallback; using
	// `??` here would silently break dedup for plugins whose label is `''`.
	const name = plugin.label || basename(plugin.uri);
	const description = plugin.fromMarketplace?.description ?? labelService.getUriLabel(dirname(plugin.uri), { relative: true });
	const marketplace = plugin.fromMarketplace?.marketplace;
	return { kind: AgentPluginItemKind.Installed, name, description, marketplace, plugin };
}

//#endregion

/**
 * Widget that displays a list of agent plugins with marketplace browsing.
 * Follows the same patterns as {@link McpListWidget}.
 */
export class PluginListWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidSelectPlugin = this._register(new Emitter<IAgentPluginItem>());
	readonly onDidSelectPlugin = this._onDidSelectPlugin.event;

	private readonly _onDidChangeItemCount = this._register(new Emitter<number>());
	readonly onDidChangeItemCount = this._onDidChangeItemCount.event;

	private sectionTitleHeader!: HTMLElement;
	private sectionLink!: HTMLAnchorElement;
	private tableHeader!: HTMLElement;
	private searchAndButtonContainer!: HTMLElement;
	private searchInput!: InputBox;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IPluginListEntry>;
	private emptyContainer!: HTMLElement;
	private emptyText!: HTMLElement;
	private emptySubtext!: HTMLElement;
	private disabledContainer!: HTMLElement;
	private disabledIcon!: HTMLElement;
	private disabledMessage!: HTMLElement;
	private readonly disabledLinkListener = this._register(new MutableDisposable());
	private buttonContainer!: HTMLElement;
	private browseButton!: Button;
	private backButton!: Button;
	private addButtonContainer!: HTMLElement;
	private addButtonSimple!: Button;
	private addButton!: ButtonWithDropdown;
	private updatePluginsButton!: Button;
	private readonly addDropdownActions = this._register(new DisposableStore());

	private installedItems: IInstalledPluginItem[] = [];
	private remoteItems: ICustomizationItem[] = [];
	private piPackageRows: readonly IPiPackageRow[] = [];
	/** The update check's answers, by install directory; empty until the first check answers. */
	private packageUpdateStatuses = new Map<string, IPiPackageUpdateStatus>();
	/** Whether one check is already running; the next one waits instead of stacking requests. */
	private packageUpdatesInFlight = false;
	/** The last answers, serialized — repainting happens only when they actually changed. */
	private packageUpdateStatusesJson = '';
	private displayEntries: IPluginListEntry[] = [];
	private marketplaceItems: IMarketplacePluginItem[] = [];
	private searchQuery: string = '';
	private browseMode: boolean = false;
	private lastHeight: number = 0;
	private lastWidth: number = 0;
	private lastHeaderHeight = 0;
	private _layoutDeferred = false;
	private readonly collapsedGroups = new Set<string>();
	private marketplaceCts: CancellationTokenSource | undefined;
	private readonly delayedFilter = new Delayer<void>(200);
	private readonly delayedMarketplaceSearch = new Delayer<void>(400);

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentPluginService private readonly agentPluginService: IAgentPluginService,
		@IPluginMarketplaceService private readonly pluginMarketplaceService: IPluginMarketplaceService,
		@IPluginInstallService private readonly pluginInstallService: IPluginInstallService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILabelService private readonly labelService: ILabelService,
		@ICommandService private readonly commandService: ICommandService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IAICustomizationItemsModel private readonly itemsModel: IAICustomizationItemsModel,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
		this.element = $('.mcp-list-widget'); // reuse MCP list widget CSS
		this.create();
		this.updateAccessState();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.PluginsEnabled)) {
				this.updateAccessState();
			}
		}));
		this._register({
			dispose: () => {
				this.marketplaceCts?.dispose();
			}
		});
	}

	private create(): void {
		// Section title header (title + description with inline learn more) at the top.
		this.sectionTitleHeader = DOM.append(this.element, $('.section-title-header'));
		const titleRow = DOM.append(this.sectionTitleHeader, $('.section-title-row'));
		const sectionTitle = DOM.append(titleRow, $('h2.section-title'));
		sectionTitle.textContent = localize('plugins', "Packages");
		const sectionTitleDescription = DOM.append(this.sectionTitleHeader, $('p.section-title-description'));
		const sectionTitleDescriptionText = DOM.append(sectionTitleDescription, $('span.section-title-description-text'));
		sectionTitleDescriptionText.textContent = localize('pluginsDescription', "Extend pi with packages that add extensions, skills, prompts, and MCP servers — the ones pi runs in this editor.");
		// Real whitespace text node between description and link so the gap collapses
		// when the link wraps to a new line (a CSS margin-left would push it inward).
		sectionTitleDescription.appendChild(document.createTextNode(' '));
		this.sectionLink = DOM.append(sectionTitleDescription, $('a.section-title-link')) as HTMLAnchorElement;
		this.sectionLink.textContent = localize('learnMorePlugins', "Browse pi packages on pi.dev");
		this.sectionLink.href = 'https://pi.dev/packages';
		this._register(DOM.addDisposableListener(this.sectionLink, 'click', (e) => {
			e.preventDefault();
			const href = this.sectionLink.href;
			if (href) {
				this.openerService.open(URI.parse(href));
			}
		}));

		// Re-layout when the header height changes so the list's allotted
		// height stays in sync with the actual on-screen header size. Only
		// relayout when the header height actually changed to avoid redundant
		// work on DPR changes or width-only resizes.
		const targetWindow = DOM.getWindow(this.element);
		const headerObserver = this._register(new DOM.DisposableResizeObserver(
			'PluginListWidget.sectionTitleHeader',
			() => {
				if (this.lastWidth <= 0 || this.lastHeight <= 0) {
					return;
				}
				const headerHeight = this.sectionTitleHeader.offsetHeight;
				if (headerHeight === this.lastHeaderHeight) {
					return;
				}
				this.layout(this.lastHeight, this.lastWidth);
			},
			targetWindow,
		));
		this._register(headerObserver.observe(this.sectionTitleHeader));

		// Search and button container
		this.searchAndButtonContainer = DOM.append(this.element, $('.list-search-and-button-container'));

		// Search container
		const searchContainer = DOM.append(this.searchAndButtonContainer, $('.list-search-container'));
		this.searchInput = this._register(new InputBox(searchContainer, this.contextViewService, {
			placeholder: localize('searchPluginsPlaceholder', "Search pi packages..."),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		this._register(this.searchInput.onDidChange(() => {
			this.searchQuery = this.searchInput.value;
			if (this.browseMode) {
				this.delayedMarketplaceSearch.trigger(() => this.queryMarketplace());
			} else {
				this.delayedFilter.trigger(() => this.filterPlugins());
			}
		}));

		// Button container (Browse Marketplace + Add actions + Create Plugin + Update Plugins)
		this.buttonContainer = DOM.append(this.searchAndButtonContainer, $('.list-button-group'));

		// Back button (visible only in marketplace browse mode)
		const backButtonContainer = DOM.append(this.buttonContainer, $('.list-add-button-container'));
		const backToInstalledLabel = localize('backToInstalledPlugins', "Back to Installed Plugins");
		this.backButton = this._register(new Button(backButtonContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: backToInstalledLabel, ariaLabel: backToInstalledLabel }));
		this.backButton.label = `$(${Codicon.arrowLeft.id}) ${localize('pluginBrowseBack', "Back")}`;
		this.backButton.element.classList.add('list-add-button');
		backButtonContainer.style.display = 'none';
		this._register(this.backButton.onDidClick(() => this.toggleBrowseMode(false)));

		const browseButtonContainer = DOM.append(this.buttonContainer, $('.list-add-button-container'));
		const browseMarketplaceLabel = localize('browseMarketplace', "Browse Packages");
		this.browseButton = this._register(new Button(browseButtonContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: browseMarketplaceLabel, ariaLabel: browseMarketplaceLabel }));
		this.browseButton.element.classList.add('list-add-button');
		this._register(this.browseButton.onDidClick(() => this.runPrimaryButtonAction()));

		this.addButtonContainer = DOM.append(this.buttonContainer, $('.list-add-button-container'));
		const addPluginLabel = localize('addPlugin', "Install from Repository");
		this.addButtonSimple = this._register(new Button(this.addButtonContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: addPluginLabel, ariaLabel: addPluginLabel }));
		this.addButtonSimple.element.classList.add('list-add-button');
		this._register(this.addButtonSimple.onDidClick(() => this.runPrimaryAddAction()));

		this.addButton = this._register(new ButtonWithDropdown(this.addButtonContainer, {
			...defaultButtonStyles,
			secondary: true,
			supportIcons: true,
			contextMenuProvider: this.contextMenuService,
			addPrimaryActionToDropdown: false,
			actions: { getActions: () => this.getAddDropdownActions() },
			title: addPluginLabel,
			ariaLabel: addPluginLabel,
		}));
		this.addButton.element.classList.add('list-add-button');
		this._register(this.addButton.onDidClick(() => this.runPrimaryAddAction()));

		const updatePluginsLabel = localize('updatePlugins', "Update Packages");
		this.updatePluginsButton = this._register(new Button(this.buttonContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true, title: updatePluginsLabel, ariaLabel: updatePluginsLabel }));
		this.updatePluginsButton.element.classList.add('list-icon-button');
		this.updatePluginsButton.label = `$(${Codicon.refresh.id})`;
		this._register(this.updatePluginsButton.onDidClick(() => this.runUpdatePluginsAction()));

		// Empty state
		this.emptyContainer = DOM.append(this.element, $('.mcp-empty-state'));
		const emptyHeader = DOM.append(this.emptyContainer, $('.empty-state-header'));
		this.emptyText = DOM.append(emptyHeader, $('.empty-text'));
		this.emptySubtext = DOM.append(this.emptyContainer, $('.empty-subtext'));

		// Disabled (access blocked) state — shown when chat.plugins.enabled is false,
		// either by user setting or by enterprise policy.
		this.disabledContainer = DOM.append(this.element, $('.mcp-disabled-state'));
		const disabledHeader = DOM.append(this.disabledContainer, $('.empty-state-header'));
		this.disabledIcon = DOM.append(disabledHeader, $('.empty-icon'));
		const disabledText = DOM.append(disabledHeader, $('.empty-text'));
		disabledText.textContent = localize('pluginsDisabledTitle', "Plugins are disabled");
		this.disabledMessage = DOM.append(this.disabledContainer, $('.empty-subtext'));

		// List container
		// The installed packages read as a table: a small header row above the list, one grid
		// row per package below (see PluginPiPackageRowRenderer). The header is hidden in
		// browse mode and whenever the list itself is hidden.
		this.tableHeader = DOM.append(this.element, $('.pi-packages-table-header'));
		for (const label of [
			localize('packagesTableColumnName', "Name"),
			localize('packagesTableColumnVersion', "Version"),
			localize('packagesTableColumnSource', "Source"),
			localize('packagesTableColumnState', "State"),
			localize('packagesTableColumnActions', "Actions"),
		]) {
			DOM.append(this.tableHeader, $('.pi-packages-table-column')).textContent = label;
		}

		this.listContainer = DOM.append(this.element, $('.mcp-list-container'));

		// Section footer (removed — see section-title-header at top)

		// Create list
		const delegate = new PluginItemDelegate();
		const groupHeaderRenderer = new CustomizationGroupHeaderRenderer<IPluginGroupHeaderEntry>('pluginGroupHeader', this.hoverService);
		const installedRenderer = new PluginInstalledItemRenderer();
		const piPackageRenderer = new PluginPiPackageRowRenderer(
			row => { void this.togglePackageState(row); },
			row => { void this.uninstallPackage(row); },
			row => { void this.updatePackage(row); },
		);
		const remoteRenderer = new PluginRemoteItemRenderer();
		const marketplaceRenderer = new GalleryItemRenderer<IPluginMarketplaceItemEntry>(PLUGIN_MARKETPLACE_ITEM_TEMPLATE_ID, new PluginMarketplaceItemProvider(
			this.pluginInstallService,
			this.agentPluginService,
			this.commandService,
			this.dialogService,
			() => this.exitBrowseMode(),
		));

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IPluginListEntry>,
			'PluginManagementList',
			this.listContainer,
			delegate,
			[groupHeaderRenderer, installedRenderer, piPackageRenderer, remoteRenderer, marketplaceRenderer],
			{
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel(element: IPluginListEntry) {
						if (element.type === 'group-header') {
							return localize('pluginGroupAriaLabel', "{0}, {1} items, {2}", element.label, element.count, element.collapsed ? localize('collapsed', "collapsed") : localize('expanded', "expanded"));
						}
						if (element.type === 'pi-package-item') {
							const rowState = element.row.state === 'disabled'
												? localize('pluginPiPackageItemDisabled', "Disabled")
												: localize('pluginPiPackageItemEnabled', "Enabled");
							const update = element.row.update;
							const updateNote = element.row.state !== 'disabled' && update?.state === 'behind' && update.latest
								? localize('pluginPiPackageItemBehind', "update to {0} available", update.latest)
								: update?.state === 'uncheckable' || update?.state === 'unknown'
									? localize('pluginPiPackageItemCannotCheck', "cannot check for updates")
									: undefined;
							return updateNote === undefined
								? localize('pluginPiPackageItemAriaLabel', "{0}. {1}", element.row.name, rowState)
								: localize('pluginPiPackageItemAriaLabelWithUpdate', "{0}. {1}, {2}", element.row.name, rowState, updateNote);
						}
						const name = formatDisplayName(element.item.name);
						const description = element.item.description ? truncateToFirstLine(element.item.description) : undefined;
						const nameAndDesc = description
							? localize('pluginItemAriaLabel', "{0}. {1}", name, description)
							: name;
						if (element.type === 'plugin-item') {
							const enabled = isContributionEnabled(element.item.plugin.enablement.get());
							return enabled
								? localize('pluginInstalledItemAriaLabelEnabled', "{0}. Enabled", nameAndDesc)
								: localize('pluginInstalledItemAriaLabelDisabled', "{0}. Disabled", nameAndDesc);
						}
						return nameAndDesc;
					},
					getWidgetAriaLabel() {
						return localize('pluginsListAriaLabel', "Packages");
					}
				},
				openOnSingleClick: true,
				identityProvider: {
					getId(element: IPluginListEntry) {
						if (element.type === 'group-header') {
							return element.id;
						}
						if (element.type === 'marketplace-item') {
							return `marketplace-${element.item.marketplaceReference.canonicalId}/${element.item.source}`;
						}
						if (element.type === 'remote-item') {
							return element.item.itemKey ?? `remote-${element.item.groupKey ?? 'default'}-${element.item.uri.toString()}`;
						}
						if (element.type === 'pi-package-item') {
							return `pi-package-${element.row.id}`;
						}
						return element.item.plugin.uri.toString();
					}
				}
			}
		));

		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				if (e.element.type === 'group-header') {
					this.toggleGroup(e.element);
				} else if (e.element.type === 'plugin-item') {
					this._onDidSelectPlugin.fire(e.element.item);
				} else if (e.element.type === 'remote-item') {
					// Keep row activation inert for remote-configured plugins. Management
					// actions are surfaced via the context menu and toolbar.
				} else if (e.element.type === 'marketplace-item') {
					this._onDidSelectPlugin.fire(e.element.item);
				}
			}
		}));

		// Handle context menu
		this._register(this.list.onContextMenu(e => this.onContextMenu(e as IListContextMenuEvent<IPluginListEntry>)));

		// Listen to plugin service changes
		this._register(autorun(reader => {
			const plugins = this.agentPluginService.plugins.read(reader);
			for (const plugin of plugins) {
				plugin.enablement.read(reader);
			}
			if (!this.browseMode) {
				void this.refresh();
			}
		}));
		this._register(this.pluginMarketplaceService.onDidChangeMarketplaces(() => {
			if (!this.browseMode) {
				void this.refresh();
			}
		}));

		// Re-render when the active harness changes (sync checkboxes may appear/disappear)
		this._register(autorun(reader => {
			this.harnessService.activeHarness.read(reader);
			this.updateToolbarActions();
			if (!this.browseMode) {
				void this.refresh();
			}
		}));

		// Re-render when the active harness's remote item provider reports changes
		const itemProviderChangeDisposable = this._register(new MutableDisposable());
		this._register(autorun(reader => {
			this.harnessService.activeHarness.read(reader);
			const itemProvider = this.harnessService.getActiveDescriptor().itemProvider;
			if (itemProvider) {
				itemProviderChangeDisposable.value = itemProvider.onDidChange(() => {
					if (!this.browseMode) {
						void this.refresh();
					}
				});
			} else {
				itemProviderChangeDisposable.clear();
			}
		}));

		this.updateToolbarActions();

		// Initial refresh
		void this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.browseMode) {
			await this.queryMarketplace();
		} else {
			await this.filterPlugins();
		}
	}

	/**
	 * The installed pi packages, asked straight from the connector.
	 *
	 * The shared plugin discovery answers through the same command but carries only what
	 * `IAgentPlugin` can hold; the table's State and Actions need the declaration, the state
	 * and the scope, so the widget asks the connector itself. A missing connector is an empty
	 * answer, not an error: the shared discovery below still renders what it found.
	 */
	private async fetchPiPackageRows(): Promise<readonly IPiPackageRow[]> {
		try {
			return await this.commandService.executeCommand<readonly IPiPackageRow[]>(PACKAGES_LIST_COMMAND) ?? [];
		} catch {
			return [];
		}
	}

	/** The header row shows only when the table below it does. */
	private updateTableHeaderVisibility(): void {
		const visible = !this.browseMode
			&& this.piPackageRows.length > 0
			&& this.listContainer.style.display !== 'none';
		this.tableHeader.style.display = visible ? '' : 'none';
	}

	/**
	 * Disables or enables one package through the connector, then refreshes: the discovery
	 * re-reads pi's settings and the table re-asks the connector for the rows it shows.
	 */
	private async togglePackageState(row: IPiPackageRow): Promise<void> {
		if (row.source === undefined) {
			return;
		}
		const disabling = row.state !== 'disabled';
		let result: IPackageInstallResult | undefined;
		try {
			result = await this.commandService.executeCommand<IPackageInstallResult>(
				disabling ? PACKAGES_DISABLE_COMMAND : PACKAGES_ENABLE_COMMAND,
				row.source,
			);
		} catch {
			await this.dialogService.warn(localize('packagesConnectorUnavailableManage', "PiCode connector is unavailable — packages are managed from the pi CLI."));
			return;
		}
		if (result && !result.ok) {
			await this.dialogService.warn(result.message);
			return;
		}
		await this.afterPackageChange();
	}

	/**
	 * Uninstalls one package: the confirmation first — the declaration is removed from pi's
	 * settings — then the connector runs pi's own remover and the table refreshes.
	 */
	private async uninstallPackage(row: IPiPackageRow): Promise<void> {
		if (row.source === undefined) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: localize('uninstallPackageTitle', "Uninstall Package \"{0}\"?", row.name),
			detail: localize('uninstallPackageDetail', "The package's declaration is removed from pi's settings, so it will no longer load in this editor. You can reinstall it later from the package catalog."),
			primaryButton: localize('uninstallPackageButton', "Uninstall"),
			type: 'question',
		});
		if (!confirmed) {
			return;
		}
		let result: IPackageInstallResult | undefined;
		try {
			result = await this.commandService.executeCommand<IPackageInstallResult>(PACKAGES_UNINSTALL_COMMAND, row.source);
		} catch {
			await this.dialogService.warn(localize('packagesConnectorUnavailableManage', "PiCode connector is unavailable — packages are managed from the pi CLI."));
			return;
		}
		if (result && !result.ok) {
			await this.dialogService.warn(result.message);
			return;
		}
		await this.afterPackageChange();
	}

	/** A connector action changed what pi loads: refresh the discovery and this table. */
	private async afterPackageChange(): Promise<void> {
		await this.commandService.executeCommand(UpdateAgentPluginsCommandId);
		await this.refresh();
	}

	private updateAccessState(): void {
		const inspect = this.configurationService.inspect<boolean>(ChatConfiguration.PluginsEnabled);
		const value = inspect.value ?? inspect.defaultValue;
		const disabled = value === false;
		const policyLocked = inspect.policyValue === false;

		this.element.classList.toggle('access-disabled', disabled);

		if (disabled) {
			this.disabledIcon.className = 'empty-icon';
			this.disabledIcon.classList.add(...ThemeIcon.asClassNameArray(policyLocked ? Codicon.shield : pluginIcon));

			DOM.clearNode(this.disabledMessage);
			this.disabledLinkListener.clear();
			if (policyLocked) {
				this.disabledMessage.textContent = localize('pluginsDisabledByPolicy', "Plugin integration in chat is disabled by your organization. Contact your organization administrator for more information.");
			} else {
				this.disabledMessage.appendChild(document.createTextNode(localize('pluginsDisabledBySettingPrefix', "Plugins are disabled in settings. ")));
				const link = DOM.append(this.disabledMessage, $('a.mcp-disabled-settings-link')) as HTMLAnchorElement;
				link.textContent = localize('pluginsDisabledSettingLink', "Configure in settings.");
				link.href = '#';
				link.setAttribute('role', 'button');
				this.disabledLinkListener.value = DOM.addDisposableListener(link, 'click', (e) => {
					e.preventDefault();
					this.commandService.executeCommand('workbench.action.openSettings', `@id:${ChatConfiguration.PluginsEnabled}`);
				});
			}
		}
	}

	private get pluginActions(): readonly ICustomizationItemAction[] {
		return this.harnessService.getActiveDescriptor().pluginActions ?? [];
	}

	private formatActionLabel(action: ICustomizationItemAction, iconOnly = false): string {
		if (!action.icon) {
			return action.label;
		}

		return iconOnly
			? `$(${action.icon.id})`
			: `$(${action.icon.id}) ${action.label}`;
	}

	private updateToolbarActions(): void {
		const browseMarketplaceAvailable = this.isBrowseMarketplaceAvailable();
		if (!browseMarketplaceAvailable && this.browseMode) {
			this.toggleBrowseMode(false);
		}

		this.browseButton.element.parentElement!.style.display = this.browseMode ? 'none' : '';
		this.browseButton.label = `$(${Codicon.library.id}) ${localize('browseMarketplace', "Browse Packages")}`;
		this.browseButton.enabled = browseMarketplaceAvailable;
		const browseTitle = browseMarketplaceAvailable
			? localize('browseMarketplace', "Browse Packages")
			: localize('browseMarketplaceUnsupportedWeb', "Browse Packages is not available in VS Code for the Web.");
		this.browseButton.setTitle(browseTitle);
		this.browseButton.element.setAttribute('aria-label', browseTitle);

		this.updateAddButton();
	}

	private isBrowseMarketplaceAvailable(): boolean {
		return !isWeb;
	}

	private updateAddButton(): void {
		const actions = this.buildAddActions();
		const [primary, ...dropdown] = actions;
		const hasDropdown = dropdown.length > 0;

		this.addButton.element.style.display = hasDropdown ? '' : 'none';
		this.addButtonSimple.element.style.display = hasDropdown ? 'none' : '';

		if (!primary) {
			this.addButton.element.style.display = 'none';
			this.addButtonSimple.element.style.display = 'none';
			return;
		}

		if (hasDropdown) {
			this.addButton.label = this.formatActionLabel(primary);
			this.addButton.enabled = primary.enabled !== false;
			const addPrimaryTitle = primary.tooltip ?? primary.label;
			this.addButton.primaryButton.setTitle(addPrimaryTitle);
			this.addButton.primaryButton.element.setAttribute('aria-label', addPrimaryTitle);
			const moreLabel = localize('morePluginAddActions', "More Plugin Add Actions...");
			this.addButton.dropdownButton.setTitle(moreLabel);
			this.addButton.dropdownButton.element.setAttribute('aria-label', moreLabel);
		} else {
			this.addButtonSimple.label = this.formatActionLabel(primary);
			this.addButtonSimple.enabled = primary.enabled !== false;
			const addSimpleTitle = primary.tooltip ?? primary.label;
			this.addButtonSimple.setTitle(addSimpleTitle);
			this.addButtonSimple.element.setAttribute('aria-label', addSimpleTitle);
		}
	}

	private buildAddActions(): readonly ICustomizationItemAction[] {
		return [
			...this.pluginActions,
			{
				id: 'plugin.installFromRepository',
				label: localize('installFromRepository', "Install from Repository"),
				tooltip: localize('installFromRepository', "Install from Repository"),
				icon: Codicon.add,
				run: async () => {
					await this.runInstallFromRepository();
				},
			},
		];
	}

	private getAddDropdownActions(): Action[] {
		this.addDropdownActions.clear();
		return this.buildAddActions().slice(1).map((action, index) => this.addDropdownActions.add(new Action(`plugin_add_${index}`, this.formatActionLabel(action), undefined, action.enabled !== false, () => this.runPluginAction(action))));
	}

	private async runPrimaryButtonAction(): Promise<void> {
		if (!this.isBrowseMarketplaceAvailable()) {
			return;
		}

		this.toggleBrowseMode(!this.browseMode);
	}

	private async runPrimaryAddAction(): Promise<void> {
		const [primary] = this.buildAddActions();
		if (primary) {
			await this.runPluginAction(primary);
		}
	}

	/**
	 * Prompts for a git URL or owner/repo shorthand and installs the package through
	 * the PiCode connector, which decides whether the target is an npm package or a
	 * git source. Mirrors the quick-input UX of the former Install-from-Source action.
	 */
	private runInstallFromRepository(): Promise<void> {
		const store = new DisposableStore();
		const inputBox = store.add(this.quickInputService.createInputBox());
		inputBox.placeholder = localize('installFromRepositoryPlaceholder', "git URL or owner/repo");
		inputBox.prompt = localize('installFromRepositoryPrompt', "Enter a git URL or owner/repo shorthand to install a package from");
		inputBox.ignoreFocusOut = true;
		inputBox.show();

		store.add(inputBox.onDidChangeValue(() => {
			inputBox.validationMessage = undefined;
		}));

		let accepting = false;
		store.add(inputBox.onDidHide(() => {
			if (!accepting) {
				store.dispose();
			}
		}));

		store.add(inputBox.onDidAccept(async () => {
			const source = inputBox.value.trim();
			if (!source || accepting) {
				return;
			}

			// Show busy state and prevent concurrent installs.
			accepting = true;
			inputBox.busy = true;
			inputBox.enabled = false;
			// Hide the input box so it doesn't conflict with dialogs.
			inputBox.hide();
			try {
				await installPackageViaConnector(this.commandService, this.dialogService, source, source, () => this.exitBrowseMode());
			} finally {
				store.dispose();
			}
		}));
		return Promise.resolve();
	}

	private async runUpdatePluginsAction(): Promise<void> {
		this.updatePluginsButton.enabled = false;
		try {
			await this.commandService.executeCommand(UpdateAgentPluginsCommandId);
		} finally {
			this.updatePluginsButton.enabled = true;
		}
	}

	private async runPluginAction(action: ICustomizationItemAction): Promise<void> {
		if (action.enabled !== false) {
			await action.run();
		}
	}

	public showBrowseMarketplace(): void {
		if (!this.isBrowseMarketplaceAvailable()) {
			return;
		}
		if (!this.browseMode) {
			this.toggleBrowseMode(true);
		}
	}

	private toggleBrowseMode(browse: boolean): void {
		this.browseMode = browse;
		this.searchInput.value = '';
		this.searchQuery = '';

		this.browseButton.element.parentElement!.style.display = browse ? 'none' : '';
		this.backButton.element.parentElement!.style.display = browse ? '' : 'none';

		this.searchInput.setPlaceHolder(browse
			? localize('searchMarketplacePlaceholder', "Search npm for pi packages...")
			: localize('searchPluginsPlaceholder', "Search pi packages...")
		);

		if (browse) {
			void this.queryMarketplace();
		} else {
			this.marketplaceCts?.dispose(true);
			this.marketplaceItems = [];
			void this.filterPlugins();
		}
		this.updateTableHeaderVisibility();

		// Re-layout to account for the back link height change
		if (this.lastHeight > 0) {
			this.layout(this.lastHeight, this.lastWidth);
		}
	}

	private async queryMarketplace(): Promise<void> {
		this.marketplaceCts?.dispose(true);
		const cts = this.marketplaceCts = new CancellationTokenSource();

		// Show loading state
		this.emptyContainer.style.display = 'flex';
		this.listContainer.style.display = 'none';
		this.emptyText.textContent = localize('loadingMarketplace', "Loading packages...");
		this.emptySubtext.textContent = '';

		try {
			// The PiCode connector performs the npm keyword search; the text query is
			// passed through and re-applied client-side as a cheap local narrowing.
			const query = this.searchQuery.toLowerCase().trim();
			const rows = await this.commandService.executeCommand<readonly IPackageCatalogRow[]>(PACKAGES_SEARCH_COMMAND, this.searchQuery.trim()) ?? [];

			if (cts.token.isCancellationRequested) {
				return;
			}

			const filtered = rows.filter(p =>
				p.name.toLowerCase().includes(query)
				|| (p.description ?? '').toLowerCase().includes(query)
			);

			// Filter out already-installed packages
			const installedUris = new Set(this.agentPluginService.plugins.get().map(p => p.uri.toString()));
			this.marketplaceItems = filtered
				.map(npmPackageToMarketplacePlugin)
				.filter(p => {
					const expectedUri = this.pluginInstallService.getPluginInstallUri(p);
					return !installedUris.has(expectedUri.toString());
				})
				.map(marketplacePluginToItem);

			this.updateMarketplaceList();
		} catch {
			// The connector command is not registered (extension absent) or failed.
			if (!cts.token.isCancellationRequested) {
				this.marketplaceItems = [];
				this.emptyContainer.style.display = 'flex';
				this.listContainer.style.display = 'none';
				this.emptyText.textContent = localize('marketplaceError', "Unable to load packages");
				this.emptySubtext.textContent = localize('packagesConnectorUnavailableListing', "PiCode connector is unavailable — packages cannot be listed.");
			}
		}
		this.updateTableHeaderVisibility();
	}

	private updateMarketplaceList(): void {
		if (this.marketplaceItems.length === 0) {
			this.emptyContainer.style.display = 'flex';
			this.listContainer.style.display = 'none';
			if (this.searchQuery.trim()) {
				this.emptyText.textContent = localize('noMarketplaceResults', "No packages match '{0}'", this.searchQuery);
				this.emptySubtext.textContent = localize('tryDifferentSearch', "Try a different search term");
			} else {
				this.emptyText.textContent = localize('emptyMarketplace', "No packages available");
				this.emptySubtext.textContent = '';
			}
		} else {
			this.emptyContainer.style.display = 'none';
			this.listContainer.style.display = '';
		}

		const entries: IPluginListEntry[] = this.marketplaceItems.map(item => ({ type: 'marketplace-item' as const, item }));
		this.list.splice(0, this.list.length, entries);
	}

	private async getRemotePluginItems(query: string): Promise<readonly ICustomizationItem[]> {
		if (!this.harnessService.getActiveDescriptor().itemProvider) {
			return [];
		}

		try {
			const provided = await this.itemsModel.getActiveItemSource().fetchProviderItems();
			return provided.filter(item =>
				isPluginCustomizationItem(item)
				&& (!query
					|| item.name.toLowerCase().includes(query)
					|| item.description?.toLowerCase().includes(query)
					|| item.badge?.toLowerCase().includes(query))
			);
		} catch {
			return [];
		}
	}

	private getRemoteGroupMetadata(groupKey: string | undefined): { group: string; label: string; description: string } {
		return {
			group: groupKey ?? 'remote-host',
			label: localize('remoteHostGroup', "Remote"),
			description: localize('remoteHostGroupDescription', "Plugins configured directly on the remote agent host and available without local sync."),
		};
	}

	private appendGroup(entries: IPluginListEntry[], header: { group: string; label: string; description: string }, items: readonly IPluginListEntry[], isFirst: boolean): boolean {
		if (items.length === 0) {
			return isFirst;
		}

		const collapsed = this.collapsedGroups.has(header.group);
		entries.push({
			type: 'group-header',
			id: `plugin-group-${header.group}`,
			group: header.group,
			label: header.label,
			icon: pluginIcon,
			count: items.length,
			isFirst,
			description: header.description,
			collapsed,
		});
		if (!collapsed) {
			entries.push(...items);
		}
		return false;
	}

	private async filterPlugins(): Promise<void> {
		const query = this.searchQuery.toLowerCase().trim();
		const allPlugins = this.agentPluginService.plugins.get();
		this.remoteItems = [...await this.getRemotePluginItems(query)];

		// The installed pi packages, straight from the connector and narrowed locally — the
		// same client-side narrowing the marketplace search applies to its rows.
		this.piPackageRows = await this.fetchPiPackageRows();
		this.mergePackageUpdateStatuses();
		const packageRows = this.piPackageRows.filter(row => !query ||
			row.name.toLowerCase().includes(query)
			|| row.source?.toLowerCase().includes(query)
			|| row.description?.toLowerCase().includes(query)
		);

		this.installedItems = allPlugins
			.map(p => installedPluginToItem(p, this.labelService))
			.filter(item => !query ||
				item.name.toLowerCase().includes(query) ||
				item.description.toLowerCase().includes(query)
			);

		// Packages the pi listing already carries render as table rows; showing them again as
		// plugin items would put every package in the section twice. Whatever the shared
		// discovery found that the connector did not answer for keeps its old rendering.
		const packagePaths = new Set(this.piPackageRows.map(row => row.path.toLowerCase()));
		const nonPackageItems = this.installedItems.filter(item => !packagePaths.has(item.plugin.uri.fsPath.toLowerCase()));

		if (this.remoteItems.length === 0 && nonPackageItems.length === 0 && packageRows.length === 0) {
			this.emptyContainer.style.display = 'flex';
			this.listContainer.style.display = 'none';

			if (this.searchQuery.trim()) {
				this.emptyText.textContent = localize('noMatchingPlugins', "No packages match '{0}'", this.searchQuery);
				this.emptySubtext.textContent = localize('tryDifferentSearch', "Try a different search term");
			} else if (this.harnessService.getActiveDescriptor().itemProvider) {
				this.emptyText.textContent = localize('noRemotePlugins', "No plugins configured");
				this.emptySubtext.textContent = localize('addRemotePlugins', "Use the toolbar to add remote plugins or install plugins from a source.");
			} else {
				this.emptyText.textContent = localize('noPlugins', "No packages installed.");
				this.emptySubtext.textContent = localize('browseToAdd', "Use Browse Packages to discover and install pi packages from npm.");
			}
		} else {
			this.emptyContainer.style.display = 'none';
			this.listContainer.style.display = '';
		}
		this.updateTableHeaderVisibility();

		// Group plugins: enabled vs disabled — the leftovers the pi table does not carry.
		const enabledPlugins = nonPackageItems.filter(item => isContributionEnabled(item.plugin.enablement.get()));
		const disabledPlugins = nonPackageItems.filter(item => !isContributionEnabled(item.plugin.enablement.get()));

		const entries: IPluginListEntry[] = [];
		let isFirst = true;

		const installedNames = new Set(this.installedItems.map(item => item.name.toLowerCase()));
		const remoteGroups = new Map<string, IPluginRemoteItemEntry[]>();
		for (const item of this.remoteItems) {
			const key = item.groupKey ?? 'remote-host';
			if (key === 'remote-client') {
				continue; // client-synced items are already shown in "Enabled Locally"
			}
			if (item.name && installedNames.has(item.name.toLowerCase())) {
				continue; // plugin is also locally installed; show it once in "Enabled Locally"
			}
			let group = remoteGroups.get(key);
			if (!group) {
				group = [];
				remoteGroups.set(key, group);
			}
			group.push({ type: 'remote-item', item });
		}
		for (const [groupKey, items] of remoteGroups) {
			isFirst = this.appendGroup(entries, this.getRemoteGroupMetadata(groupKey), items, isFirst);
		}

		if (packageRows.length > 0) {
			entries.push(...packageRows.map(row => ({ type: 'pi-package-item' as const, row })));
		}

		if (enabledPlugins.length > 0) {
			isFirst = this.appendGroup(
				entries,
				{
					group: 'enabled',
					label: localize('enabledGroup', "Enabled Locally"),
					description: localize('enabledGroupDescription', "Plugins installed in this client and available for syncing to the remote session."),
				},
				enabledPlugins.map(item => ({ type: 'plugin-item' as const, item })),
				isFirst,
			);
		}

		if (disabledPlugins.length > 0) {
			this.appendGroup(
				entries,
				{
					group: 'disabled',
					label: localize('disabledGroup', "Disabled Locally"),
					description: localize('disabledGroupDescription', "Plugins installed in this client but currently disabled."),
				},
				disabledPlugins.map(item => ({ type: 'plugin-item' as const, item })),
				isFirst,
			);
		}

		this.displayEntries = entries;
		this.list.splice(0, this.list.length, this.displayEntries);

		// The check runs after the table is already painted — it is a registry call per checkable
		// package and must never hold the list open — and repaints once, when its answers change
		// what a row says.
		this.requestPackageUpdateStatuses();

		// Compute sidebar badge directly from the data array (same source as group headers)
		this._onDidChangeItemCount.fire(this.itemCount);
	}

	/** Carries the answers the last check gave into the rows that are on screen now. */
	private mergePackageUpdateStatuses(): void {
		if (this.packageUpdateStatuses.size === 0) {
			return;
		}
		this.piPackageRows = this.piPackageRows.map(row => {
			const update = this.packageUpdateStatuses.get(row.path);
			return update === undefined ? row : { ...row, update };
		});
	}

	/**
	 * Asks the connector which installed packages npm knows a newer version of.
	 *
	 * One check at a time; the connector caches each package's latest version for ten minutes,
	 * so refreshing the page inside that lifetime re-asks it for nothing. The repaint runs only
	 * when an answer actually changed, so the refresh this triggers cannot loop back into
	 * another repaint.
	 */
	private requestPackageUpdateStatuses(): void {
		if (this.piPackageRows.length === 0 || this.packageUpdatesInFlight) {
			return;
		}
		this.packageUpdatesInFlight = true;
		this.commandService.executeCommand<readonly IPiPackageUpdateStatusRow[]>(PACKAGES_UPDATES_CHECK_COMMAND).then(statuses => {
			this.packageUpdatesInFlight = false;
			if (!Array.isArray(statuses)) {
				return;
			}
			const next = new Map<string, IPiPackageUpdateStatus>();
			for (const status of statuses) {
				if (typeof status?.path === 'string') {
					next.set(status.path, {
						state: status.state,
						...(status.latest === undefined ? {} : { latest: status.latest }),
						...(status.reason === undefined ? {} : { reason: status.reason }),
					});
				}
			}
			const nextJson = JSON.stringify([...next.entries()].sort(([a], [b]) => a.localeCompare(b)));
			const changed = nextJson !== this.packageUpdateStatusesJson;
			this.packageUpdateStatusesJson = nextJson;
			this.packageUpdateStatuses = next;
			if (changed && !this.browseMode) {
				void this.filterPlugins();
			}
		}, () => {
			this.packageUpdatesInFlight = false;
		});
	}

	/**
	 * Updates one package through the connector — the click on a row that says it is behind —
	 * then refreshes, so the row's hint and its version tell the truth again. A failure is the
		 * connector's one sentence; a success says nothing, the refreshed row is the answer.
	 */
	private async updatePackage(row: IPiPackageRow): Promise<void> {
		if (row.source === undefined) {
			return;
		}
		let result: IPackageInstallResult | undefined;
		try {
			result = await this.commandService.executeCommand<IPackageInstallResult>(PACKAGES_UPDATE_COMMAND, row.source);
		} catch {
			await this.dialogService.warn(localize('packagesConnectorUnavailableManage', "PiCode connector is unavailable — packages are managed from the pi CLI."));
			return;
		}
		if (!result) {
			return;
		}
		if (!result.ok) {
			await this.dialogService.warn(result.message);
			return;
		}
		await this.afterPackageChange();
	}

	/**
	 * Gets the total item count from the underlying data array
	 * (the same source used to build group headers).
	 */
	get itemCount(): number {
		const installedNames = new Set(this.installedItems.map(item => item.name.toLowerCase()));
		const uniqueRemote = this.remoteItems.filter(item => {
			if (item.groupKey === 'remote-client') {
				return false;
			}
			if (item.name && installedNames.has(item.name.toLowerCase())) {
				return false;
			}
			return true;
		});
		return uniqueRemote.length + this.installedItems.length;
	}

	/**
	 * Re-fires the current item count. Call after subscribing to onDidChangeItemCount
	 * to ensure the subscriber receives the latest count.
	 */
	fireItemCount(): void {
		this._onDidChangeItemCount.fire(this.itemCount);
	}

	private toggleGroup(entry: IPluginGroupHeaderEntry): void {
		if (this.collapsedGroups.has(entry.group)) {
			this.collapsedGroups.delete(entry.group);
		} else {
			this.collapsedGroups.add(entry.group);
		}
		void this.filterPlugins();
	}

	/**
	 * Whether the widget is currently in marketplace browse mode.
	 */
	isInBrowseMode(): boolean {
		return this.browseMode;
	}

	/**
	 * Exits marketplace browse mode and returns to the installed plugins list.
	 */
	exitBrowseMode(): void {
		if (this.browseMode) {
			this.toggleBrowseMode(false);
		}
	}

	layout(height: number, width: number): void {
		this.lastHeight = height;
		this.lastWidth = width;

		this.element.style.height = `${height}px`;

		// Measure sibling elements to calculate the list height.
		// When offsetHeight returns 0 the container may have just become visible
		// after display:none and the browser hasn't reflowed yet — defer layout
		// once so measurements are accurate. Only retry once to avoid an endless
		// loop when the widget is created while permanently hidden.
		const searchBarHeight = this.searchAndButtonContainer.offsetHeight;
		if (searchBarHeight === 0 && !this._layoutDeferred) {
			this._layoutDeferred = true;
			DOM.getWindow(this.element).requestAnimationFrame(() => {
				try {
					this.layout(this.lastHeight, this.lastWidth);
				} finally {
					this._layoutDeferred = false;
				}
			});
			return;
		}
		const headerHeight = this.sectionTitleHeader.offsetHeight;
		this.lastHeaderHeight = headerHeight;
		// The table's header row sits above the list, so the list gets what it does not use.
		const tableHeaderHeight = this.tableHeader.offsetHeight;
		const listHeight = Math.max(0, height - searchBarHeight - headerHeight - tableHeaderHeight);

		this.listContainer.style.height = `${listHeight}px`;
		this.list.layout(listHeight, width);
	}

	focusSearch(): void {
		this.searchInput.focus();
	}

	revealLastItem(): void {
		if (this.list.length > 0) {
			this.list.reveal(this.list.length - 1);
		}
	}

	focus(): void {
		this.list.domFocus();
		if (this.list.length > 0) {
			this.list.setFocus([0]);
		}
	}

	private onContextMenu(e: IListContextMenuEvent<IPluginListEntry>): void {
		// The pi package table rows carry their actions inline, and the other two kinds have
		// no item to act on.
		if (!e.element || e.element.type === 'group-header' || e.element.type === 'marketplace-item' || e.element.type === 'pi-package-item') {
			return;
		}

		const entry = e.element;
		const disposables = new DisposableStore();
		const actions: IAction[] = [];

		if (entry.type === 'plugin-item') {
			const groups = getInstalledPluginContextMenuActions(entry.item.plugin, this.instantiationService);
			for (const menuActions of groups) {
				for (const menuAction of menuActions) {
					actions.push(menuAction);
					if (isDisposable(menuAction)) {
						disposables.add(menuAction);
					}
				}
				actions.push(new Separator());
			}
			if (actions.length > 0 && actions[actions.length - 1] instanceof Separator) {
				actions.pop();
			}
		} else {
			const itemActions = entry.item.actions ?? [];
			for (const itemAction of itemActions) {
				actions.push(new Action(
					itemAction.id,
					itemAction.label,
					itemAction.icon ? ThemeIcon.asClassName(itemAction.icon) : undefined,
					itemAction.enabled !== false,
					() => itemAction.run(),
				));
			}
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => actions,
			onHide: () => disposables.dispose()
		});
	}
}
