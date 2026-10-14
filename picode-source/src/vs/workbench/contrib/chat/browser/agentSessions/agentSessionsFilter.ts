/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
import { localize } from '../../../../../nls.js';
import { registerAction2, Action2, MenuId } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { AgentSessionProviders, getAgentSessionProvider, getAgentSessionProviderName } from './agentSessions.js';
import { AgentSessionStatus, IAgentSession } from './agentSessionsModel.js';
import { IAgentSessionsFilter, IAgentSessionsFilterExcludes } from './agentSessionsViewer.js';

export enum AgentSessionsGrouping {
	Capped = 'capped',
	Date = 'date',
	Repository = 'repository'
}

export enum AgentSessionsSorting {
	Created = 'created',
	Updated = 'updated'
}

export interface IAgentSessionsFilterOptions extends Partial<IAgentSessionsFilter> {

	readonly filterMenuId?: MenuId;

	/**
	 * When set, only these providers appear in the filter menu (opt-in).
	 * When unset, all registered contributions plus `Local` are shown.
	 */
	readonly allowedProviders?: AgentSessionProviders[];

	/**
	 * Optional label overrides for providers shown in the filter menu.
	 * For example, the sessions window maps `Background` → "Local".
	 */
	readonly providerLabelOverrides?: ReadonlyMap<string, string>;

	readonly limitResults?: () => number | undefined;
	notifyResults?(count: number): void;

	readonly groupResults?: () => AgentSessionsGrouping | undefined;
	readonly sortResults?: () => AgentSessionsSorting | undefined;

	overrideExclude?(session: IAgentSession): boolean | undefined;
}

/**
 * The id PiCode's own transcripts are listed under, and the id of the list the panel **hides**.
 *
 * The owner's final shape (ADR-021 corrected): the chat's conversations **live in durable** —
 * pi thinks, durable remembers — so the panel's one list is durable's conversations, and pi's
 * JSONL transcripts are the *other* record: what the pi CLI wrote or an import landed, kept
 * reachable through the agents view, not mixed into the conversation list.
 */
export const PI_TRANSCRIPT_SESSION_PROVIDER = 'pi';

/**
 * The providers the panel never shows and never offers as a filter: they are not other lists to
 * visit, they are the records the one list replaced. `Local` is the editor's duplicate; `pi` is
 * the transcripts of another surface (the CLI, an import) — a conversation that lived there
 * belongs to durable's list once imported.
 */
export const RETIRED_SESSION_PROVIDERS: readonly string[] = [AgentSessionProviders.Local, PI_TRANSCRIPT_SESSION_PROVIDER];

/** The provider of **the one list**: the conversations that live in durable. */
export const DURABLE_SESSION_PROVIDER = 'durable';

/**
 * What the panel shows, however a previous install stored the filter: pi's transcripts, with
 * the retired providers forced out. The stored excludes may still carry a pre-one-list state
 * (a `pi` hidden by the old toggle, a `Local` shown by it); normalization is what makes the
 * owner's rule hold without asking anyone to reset anything.
 */
export function normalizedExcludes(excludes: IAgentSessionsFilterExcludes, registered?: readonly string[]): IAgentSessionsFilterExcludes {
	// The one list is durable's conversations — **when durable exists**. An external pi may
	// carry no durable at all (another backend, or nothing but pi): there, the one list is
	// pi's transcripts, and durable — unregistered, therefore unshowable — joins the retired.
	// Without the caller's registration snapshot, durable is assumed (the editor's shape).
	const oneList = registered !== undefined && !registered.includes(DURABLE_SESSION_PROVIDER)
		? PI_TRANSCRIPT_SESSION_PROVIDER
		: DURABLE_SESSION_PROVIDER;
	const retired = new Set(RETIRED_SESSION_PROVIDERS);
	retired.delete(oneList);
	const providers = new Set(excludes.providers);
	providers.delete(oneList);
	for (const hidden of retired) {
		providers.add(hidden);
	}
	return { ...excludes, providers: Array.from(providers) };
}

/** What the panel hides before the owner touches the filter; exported so a test can pin it. */
export const DEFAULT_EXCLUDES: IAgentSessionsFilterExcludes = Object.freeze(normalizedExcludes({
	// The one list is durable's conversations; the retired providers never come back.
	providers: [] as const,
	states: [] as const,
	archived: true as const /* archived are never excluded but toggle between expanded and collapsed */,
	read: false as const,
	repositoryGroupCapped: true as const /* when true, repo groups are capped at a limit with a "show more" item */,
}));

export class AgentSessionsFilter extends Disposable implements Required<IAgentSessionsFilter> {

	private readonly STORAGE_KEY = `agentSessions.filterExcludes.agentsessionsviewerfiltersubmenu`;
	private readonly SORTING_STORAGE_KEY = `agentSessions.sorting`;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	readonly limitResults = () => this.options.limitResults?.();
	readonly groupResults = () => this.options.groupResults?.();
	readonly sortResults = (): AgentSessionsSorting | undefined => this.options.sortResults?.() ?? this.currentSorting;

	private excludes = DEFAULT_EXCLUDES;
	private isStoringExcludes = false;
	private currentSorting: AgentSessionsSorting = AgentSessionsSorting.Created;

	private readonly actionDisposables = this._register(new DisposableStore());

	constructor(
		private readonly options: IAgentSessionsFilterOptions,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.restoreSorting();
		this.updateExcludes(false);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.chatSessionsService.onDidChangeItemsProviders(() => {
			// A provider registered AFTER this filter was built (the connector's `durable` and
			// `pi` arrive imperatively, with extension activation, possibly after the panel)
			// changes which list is the one list. The excludes renormalize here, or a provider
			// that just became the one list stays hidden behind a decision made too early —
			// the "No matching sessions · Reset Filter" that reset could not fix.
			const next = normalizedExcludes(this.excludes, this.chatSessionsService.getRegisteredChatSessionItemProviders());
			console.log(`[agentSessions.filter] providers changed — excluded: [${next.providers.join(', ')}]`);
			// Fire ONLY when the normalization moved something: a fire with the same result
			// makes the panel re-filter, and if that re-filter reaches back into provider
			// events the loop re-renders the list at flash speed — the "quitar y poner el
			// filtro" the owner saw.
			const changed = JSON.stringify(next) !== JSON.stringify(this.excludes);
			this.excludes = next;
			this.updateFilterActions();
			if (changed) {
				this._onDidChange.fire();
			}
		}));
		this._register(this.chatSessionsService.onDidChangeAvailability(() => this.updateFilterActions()));

		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, this.STORAGE_KEY, this._store)(() => this.updateExcludes(true)));
	}

	private updateExcludes(fromEvent: boolean): void {
		if (!this.isStoringExcludes) {
			const excludedTypesRaw = this.storageService.get(this.STORAGE_KEY, StorageScope.PROFILE);
			if (excludedTypesRaw) {
				try {
					// Normalized, not trusted: a state stored by an install that still offered the
					// provider toggles must not resurrect a hidden `pi` or a visible `Local`. See
					// `normalizedExcludes`.
					this.excludes = normalizedExcludes(JSON.parse(excludedTypesRaw) as IAgentSessionsFilterExcludes, this.chatSessionsService.getRegisteredChatSessionItemProviders());
				} catch {
					this.excludes = { ...DEFAULT_EXCLUDES };
				}
			} else {
				// The default hides the same thing the stored path does — whichever list is the
				// one list for THIS install (durable when it is registered; the transcripts
				// otherwise). `DEFAULT_EXCLUDES` assumes durable: it exists before the
				// registrations are known.
				this.excludes = normalizedExcludes({ ...DEFAULT_EXCLUDES }, this.chatSessionsService.getRegisteredChatSessionItemProviders());
			}
		}

		this.updateFilterActions();

		if (fromEvent) {
			this._onDidChange.fire();
		}
	}

	private storeExcludes(excludes: IAgentSessionsFilterExcludes): void {
		this.excludes = excludes;

		// Set guard before storage operation to prevent our own listener from
		// re-triggering updateExcludes which would re-register actions mid-click
		this.isStoringExcludes = true;
		try {
			if (equals(this.excludes, DEFAULT_EXCLUDES)) {
				this.storageService.remove(this.STORAGE_KEY, StorageScope.PROFILE);
			} else {
				this.storageService.store(this.STORAGE_KEY, JSON.stringify(this.excludes), StorageScope.PROFILE, StorageTarget.USER);
			}
		} finally {
			this.isStoringExcludes = false;
		}
	}

	private restoreSorting(): void {
		const storedSorting = this.storageService.get(this.SORTING_STORAGE_KEY, StorageScope.PROFILE);
		if (storedSorting && Object.values(AgentSessionsSorting).includes(storedSorting as AgentSessionsSorting)) {
			this.currentSorting = storedSorting as AgentSessionsSorting;
		}
	}

	setSorting(sorting: AgentSessionsSorting): void {
		if (this.currentSorting === sorting) {
			return;
		}

		this.currentSorting = sorting;
		this.storageService.store(this.SORTING_STORAGE_KEY, sorting, StorageScope.PROFILE, StorageTarget.USER);
		this.updateFilterActions();
		this._onDidChange.fire();
	}

	private updateFilterActions(): void {
		this.actionDisposables.clear();

		const menuId = this.options.filterMenuId;
		if (!menuId) {
			return;
		}

		this.registerSortActions(this.actionDisposables, menuId);
		// **No provider toggles.** The panel's list is the one list (pi's durable transcripts) and
		// the owner retired the filter that moved between Local, pi and durable. A consumer that
		// genuinely has several providers of its own still opts in with `allowedProviders`.
		if (this.options.allowedProviders) {
			this.registerProviderActions(this.actionDisposables, menuId);
		}
		this.registerStateActions(this.actionDisposables, menuId);
		this.registerArchivedActions(this.actionDisposables, menuId);
		this.registerReadActions(this.actionDisposables, menuId);
		this.registerResetAction(this.actionDisposables, menuId);
	}

	private registerSortActions(disposables: DisposableStore, menuId: MenuId): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.sortByCreated.${menuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.sortByCreated', 'Sort by Created'),
					menu: {
						id: menuId,
						group: '0_sort',
						order: 0,
					},
					toggled: that.currentSorting === AgentSessionsSorting.Created ? ContextKeyExpr.true() : ContextKeyExpr.false(),
				});
			}
			run(): void {
				that.setSorting(AgentSessionsSorting.Created);
			}
		}));

		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.sortByUpdated.${menuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.sortByUpdated', 'Sort by Updated'),
					menu: {
						id: menuId,
						group: '0_sort',
						order: 1,
					},
					toggled: that.currentSorting === AgentSessionsSorting.Updated ? ContextKeyExpr.true() : ContextKeyExpr.false(),
				});
			}
			run(): void {
				that.setSorting(AgentSessionsSorting.Updated);
			}
		}));
	}

	private registerProviderActions(disposables: DisposableStore, menuId: MenuId): void {
		const allowed = this.options.allowedProviders;
		if (!allowed) {
			// Only reached with `allowedProviders` set — a menu without it has no provider
			// toggles at all (see `updateFilterActions`).
			return;
		}
		const labelOverrides = this.options.providerLabelOverrides;
		const resolveLabel = (id: string) => {
			if (labelOverrides?.has(id)) {
				return labelOverrides.get(id)!;
			}
			const knownProvider = getAgentSessionProvider(id);
			return knownProvider ? getAgentSessionProviderName(knownProvider) : id;
		};

		const providers = allowed.map(id => ({ id, label: resolveLabel(id) }));

		const that = this;
		let counter = 0;
		for (const provider of providers) {
			disposables.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `agentSessions.filter.toggleExclude:${provider.id}.${menuId.id.toLowerCase()}`,
						title: provider.label,
						menu: {
							id: menuId,
							group: '1_providers',
							order: counter++,
						},
						toggled: that.excludes.providers.includes(provider.id) ? ContextKeyExpr.false() : ContextKeyExpr.true(),
					});
				}
				run(): void {
					const excludes = new Set(that.excludes.providers);
					// A toggle is an inverse, and nothing more: the one-list rule lives in
					// `normalizedExcludes`, not here.
					if (!excludes.delete(provider.id)) {
						excludes.add(provider.id);
					}
					that.storeExcludes(normalizedExcludes({ ...that.excludes, providers: Array.from(excludes) }));
				}
			}));
		}
	}

	private registerStateActions(disposables: DisposableStore, menuId: MenuId): void {
		const states: { id: AgentSessionStatus; label: string }[] = [
			{ id: AgentSessionStatus.Completed, label: localize('agentSessionStatus.completed', "Completed") },
			{ id: AgentSessionStatus.InProgress, label: localize('agentSessionStatus.inProgress', "In Progress") },
			{ id: AgentSessionStatus.NeedsInput, label: localize('agentSessionStatus.needsInput', "Input Needed") },
			{ id: AgentSessionStatus.Failed, label: localize('agentSessionStatus.failed', "Failed") },
		];

		const that = this;
		let counter = 0;
		for (const state of states) {
			disposables.add(registerAction2(class extends Action2 {
				constructor() {
					super({
						id: `agentSessions.filter.toggleExcludeState:${state.id}.${menuId.id.toLowerCase()}`,
						title: state.label,
						menu: {
							id: menuId,
							group: '2_states',
							order: counter++,
						},
						toggled: that.excludes.states.includes(state.id) ? ContextKeyExpr.false() : ContextKeyExpr.true(),
					});
				}
				run(): void {
					const stateExcludes = new Set(that.excludes.states);
					if (!stateExcludes.delete(state.id)) {
						stateExcludes.add(state.id);
					}

					that.storeExcludes({ ...that.excludes, states: Array.from(stateExcludes) });
				}
			}));
		}
	}

	private registerArchivedActions(disposables: DisposableStore, menuId: MenuId): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.toggleExcludeArchived.${menuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.archived', 'Archived'),
					menu: {
						id: menuId,
						group: '3_props',
						order: 1000,
					},
					toggled: that.excludes.archived ? ContextKeyExpr.false() : ContextKeyExpr.true(),
				});
			}
			run(): void {
				that.storeExcludes({ ...that.excludes, archived: !that.excludes.archived });
			}
		}));
	}

	private registerReadActions(disposables: DisposableStore, menuId: MenuId): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.toggleExcludeRead.${menuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.read', 'Read'),
					menu: {
						id: menuId,
						group: '3_props',
						order: 0,
					},
					toggled: that.excludes.read ? ContextKeyExpr.false() : ContextKeyExpr.true(),
				});
			}
			run(): void {
				that.storeExcludes({ ...that.excludes, read: !that.excludes.read });
			}
		}));
	}

	/**
	 * Programmatically toggle the repository group capping state.
	 */
	setRepositoryGroupCapped(capped: boolean): void {
		if (this.excludes.repositoryGroupCapped !== capped) {
			this.storeExcludes({ ...this.excludes, repositoryGroupCapped: capped });
		}
	}

	private registerResetAction(disposables: DisposableStore, menuId: MenuId): void {
		const that = this;
		disposables.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: `agentSessions.filter.resetExcludes.${menuId.id.toLowerCase()}`,
					title: localize('agentSessions.filter.reset', "Reset"),
					menu: {
						id: menuId,
						group: '4_reset',
						order: 0,
					},
				});
			}
			run(): void {
				that.reset();
			}
		}));
	}

	isDefault(): boolean {
		return equals(this.excludes, DEFAULT_EXCLUDES) && this.currentSorting === AgentSessionsSorting.Created;
	}

	getExcludes(): IAgentSessionsFilterExcludes {
		return this.excludes;
	}

	exclude(session: IAgentSession): boolean {
		const overrideExclude = this.options?.overrideExclude?.(session);
		if (typeof overrideExclude === 'boolean') {
			return overrideExclude;
		}

		if (this.options.allowedProviders && !this.options.allowedProviders.includes(session.providerType as AgentSessionProviders)) {
			return true;
		}

		if (this.excludes.read && session.isRead()) {
			return true;
		}

		if (this.excludes.providers.includes(session.providerType)) {
			return true;
		}

		if (this.excludes.states.includes(session.status)) {
			return true;
		}

		if (this.excludes.archived && this.groupResults?.() === AgentSessionsGrouping.Capped && session.isArchived()) {
			return true; // exclude archived sessions when grouped by capped where we have no "Archived" group
		}

		return false;
	}

	notifyResults(count: number): void {
		this.options.notifyResults?.(count);
	}

	reset(): void {
		this.storeExcludes(normalizedExcludes({ ...DEFAULT_EXCLUDES }, this.chatSessionsService.getRegisteredChatSessionItemProviders()));
		if (this.currentSorting !== AgentSessionsSorting.Created) {
			this.setSorting(AgentSessionsSorting.Created);
		}
	}
}
