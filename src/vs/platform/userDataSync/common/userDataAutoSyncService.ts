/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise, createCancelablePromise, disposableTimeout, ThrottledDelayer } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { toLocalISOString } from '../../../base/common/date.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isWeb } from '../../../base/common/platform.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { IProductService } from '../../product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AutoSyncStatus, IUserDataSyncTask, IUserDataAutoSyncService, IUserDataManifest, IUserDataSyncLogService, IUserDataSyncEnablementService, IUserDataSyncService, IUserDataSyncStoreManagementService, IUserDataSyncStoreService, UserDataAutoSyncError, UserDataSyncError, UserDataSyncErrorCode, SyncOptions, ALL_SYNC_RESOURCES, SyncResource } from './userDataSync.js';
import { IUserDataSyncAccountService } from './userDataSyncAccount.js';
import { IUserDataSyncMachinesService } from './userDataSyncMachines.js';
import { LocalSyncRateLimitError, REQUEST_SESSION_INTERVAL } from './userDataSyncStoreService.js';

const disableMachineEventuallyKey = 'sync.pendingDeviceRemoval';
const sessionIdKey = 'sync.sessionId';
const storeUrlKey = 'sync.storeUrl';
const productQualityKey = 'sync.productQuality';
const pendingResourcesKey = 'sync.pendingResources';
const minimumActivityInterval = 30_000;
const foregroundSyncInterval = 5 * 60_000;
const backgroundSyncInterval = 15 * 60_000;
const wakeSources = new Set(['windowFocus', 'windowOpen', 'systemResume', 'networkOnline']);

export class UserDataAutoSyncService extends Disposable implements IUserDataAutoSyncService {

	_serviceBrand: undefined;

	private readonly autoSync = this._register(new MutableDisposable<AutoSync>());
	private successiveFailures: number = 0;
	private lastSyncTriggerTime: number | undefined = undefined;
	private syncInterval = foregroundSyncInterval;
	private readonly pendingResources = new Map<SyncResource, number>();
	private localChangeGeneration = 0;
	private readonly syncTriggerDelayer: ThrottledDelayer<void>;
	private readonly localRateLimitPause = this._register(new MutableDisposable<IDisposable>());
	private localRetryAt: number | undefined;
	private running = false;
	private failedResources: readonly SyncResource[] = [];
	private turningOffEverywhere = false;
	private readonly deviceRemovalTimer = this._register(new MutableDisposable<IDisposable>());
	private deviceRemoval: Promise<void> | undefined;
	private status: AutoSyncStatus = { state: 'idle' };
	private readonly _onDidChangeStatus = this._register(new Emitter<AutoSyncStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	async getStatus(): Promise<AutoSyncStatus> { return this.status; }

	private updateStatus(): void {
		const retryAt = this.userDataSyncStoreService.donotMakeRequestsUntil?.getTime() ?? this.localRetryAt;
		const next: AutoSyncStatus = !this.userDataSyncEnablementService.isEnabled() ? { state: 'idle' }
			: this.running ? { state: 'syncing' }
				: !this.autoSync.value || this.successiveFailures > 0 ? { state: 'paused', retryAt }
					: this.failedResources.length > 0 || this.pendingResources.size > 0 || this.sources.some(source => ALL_SYNC_RESOURCES.some(resource => resource === source)) ? { state: 'pending' } : { state: 'idle' };
		if (this.userDataSyncEnablementService.isEnabled() && this.failedResources.length) {
			next.failedResources = this.failedResources;
		}
		if (next.state !== this.status.state || next.retryAt !== this.status.retryAt || next.failedResources !== this.status.failedResources) {
			this.status = next;
			this._onDidChangeStatus.fire(next);
		}
	}

	private readonly _onError: Emitter<UserDataSyncError> = this._register(new Emitter<UserDataSyncError>());
	readonly onError: Event<UserDataSyncError> = this._onError.event;

	private lastSyncUrl: URI | undefined;
	private get syncUrl(): URI | undefined {
		const value = this.storageService.get(storeUrlKey, StorageScope.APPLICATION);
		return value ? URI.parse(value) : undefined;
	}
	private set syncUrl(syncUrl: URI | undefined) {
		if (syncUrl) {
			this.storageService.store(storeUrlKey, syncUrl.toString(), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(storeUrlKey, StorageScope.APPLICATION);
		}
	}

	private previousProductQuality: string | undefined;
	private get productQuality(): string | undefined {
		return this.storageService.get(productQualityKey, StorageScope.APPLICATION);
	}
	private set productQuality(productQuality: string | undefined) {
		if (productQuality) {
			this.storageService.store(productQualityKey, productQuality, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(productQualityKey, StorageScope.APPLICATION);
		}
	}

	constructor(
		@IProductService productService: IProductService,
		@IUserDataSyncStoreManagementService private readonly userDataSyncStoreManagementService: IUserDataSyncStoreManagementService,
		@IUserDataSyncStoreService private readonly userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncEnablementService private readonly userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IUserDataSyncLogService private readonly logService: IUserDataSyncLogService,
		@IUserDataSyncAccountService private readonly userDataSyncAccountService: IUserDataSyncAccountService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IUserDataSyncMachinesService private readonly userDataSyncMachinesService: IUserDataSyncMachinesService,
		@IStorageService private readonly storageService: IStorageService,
		@IMeteredConnectionService private readonly meteredConnectionService: IMeteredConnectionService,
	) {
		super();
		this.syncTriggerDelayer = this._register(new ThrottledDelayer<void>(this.getSyncTriggerDelayTime()));
		const stored = storageService.getObject<SyncResource[]>(pendingResourcesKey, StorageScope.APPLICATION, []);
		if (Array.isArray(stored)) {
			for (const resource of ALL_SYNC_RESOURCES) {
				if (stored.includes(resource) && userDataSyncEnablementService.isResourceEnabled(resource)) {
					this.pendingResources.set(resource, 0);
				}
			}
		}

		this.lastSyncUrl = this.syncUrl;
		this.syncUrl = userDataSyncStoreManagementService.userDataSyncStore?.url;

		this.previousProductQuality = this.productQuality;
		this.productQuality = productService.quality;

		if (this.syncUrl) {

			this.logService.info('[AutoSync] Using settings sync service', this.syncUrl.toString());
			this._register(userDataSyncStoreManagementService.onDidChangeUserDataSyncStore(() => {
				if (!isEqual(this.syncUrl, userDataSyncStoreManagementService.userDataSyncStore?.url)) {
					this.lastSyncUrl = this.syncUrl;
					this.syncUrl = userDataSyncStoreManagementService.userDataSyncStore?.url;
					if (this.syncUrl) {
						this.logService.info('[AutoSync] Using settings sync service', this.syncUrl.toString());
					}
				}
			}));

			if (this.userDataSyncEnablementService.isEnabled()) {
				this.logService.info('[AutoSync] Enabled.');
			} else {
				this.logService.info('[AutoSync] Disabled.');
			}
			this.updateAutoSync();

			if (this.hasToDisableMachineEventually()) {
				this.scheduleDeviceRemoval();
			}

			this._register(userDataSyncAccountService.onDidChangeAccount(() => this.updateAutoSync()));
			this._register(userDataSyncStoreService.onDidChangeDonotMakeRequestsUntil(() => this.updateAutoSync()));
			this._register(userDataSyncService.onDidChangeLocal(resource => {
				this.pendingResources.set(resource, ++this.localChangeGeneration);
				this.storePendingResources();
				void this.triggerSync([resource]).catch(error => this.logService.error(error));
			}));
			this._register(Event.any(userDataSyncService.onDidResetLocal, userDataSyncService.onDidResetRemote)(() => this.autoSync.value?.requireFullSync()));
			this._register(this.userDataSyncEnablementService.onDidChangeResourceEnablement(([resource, enabled]) => {
				this.autoSync.value?.requireFullSync();
				if (enabled) {
					void this.triggerSync(['resourceEnablement']).catch(error => this.logService.error(error));
				} else {
					this.failedResources = this.failedResources.filter(failed => failed !== resource);
					if (this.pendingResources.delete(resource)) {
						this.storePendingResources();
					}
					this.updateStatus();
				}
			}));
			this._register(this.userDataSyncStoreManagementService.onDidChangeUserDataSyncStore(() => this.triggerSync(['userDataSyncStoreChanged'])));
			this._register(meteredConnectionService.onDidChangeIsConnectionMetered(() => this.updateAutoSync()));
		}
	}

	private updateAutoSync(): void {
		const { enabled, message } = this.isAutoSyncEnabled();
		if (enabled) {
			if (this.autoSync.value === undefined) {
				this.autoSync.value = new AutoSync(this.lastSyncUrl, this.syncInterval, this.userDataSyncStoreManagementService, this.userDataSyncStoreService, this.userDataSyncService, this.userDataSyncMachinesService, this.logService, this.telemetryService, this.storageService, this.pendingResources, () => this.syncAccountBinding());
				this.autoSync.value.register(this.autoSync.value.onDidStartSync(() => {
					this.lastSyncTriggerTime = Date.now();
					this.running = true;
					this.updateStatus();
				}));
				this.autoSync.value.register(this.autoSync.value.onDidFinishSync(({ error, syncedResources, failedResources }) => {
					this.running = false;
					if (failedResources) {
						this.failedResources = failedResources;
					}
					if (syncedResources?.size) {
						for (const [resource, generation] of syncedResources) {
							if (this.pendingResources.get(resource) === generation) {
								this.pendingResources.delete(resource);
							}
						}
						this.storePendingResources();
					}
					void this.onDidFinishSync(error).catch(error => this.logService.error(error)).finally(() => this.updateStatus());
				}));
				if (this.startAutoSync()) {
					this.autoSync.value.start();
				}
			}
		} else {
			this.running = false;
			this.failedResources = [];
			this.syncTriggerDelayer.cancel();
			this.sources = [];
			this.pendingSyncOptions = undefined;
			if (this.autoSync.value !== undefined) {
				if (message) {
					this.logService.info(message);
				}
				this.autoSync.clear();
			}

			/* log message when auto sync is not disabled by user */
			else if (message && this.userDataSyncEnablementService.isEnabled()) {
				this.logService.info(message);
			}
		}
		this.updateStatus();
	}

	// For tests purpose only
	protected startAutoSync(): boolean { return true; }

	private isAutoSyncEnabled(): { enabled: boolean; message?: string } {
		if (this.turningOffEverywhere) {
			return { enabled: false };
		}
		if (!this.userDataSyncEnablementService.isEnabled()) {
			return { enabled: false, message: '[AutoSync] Disabled.' };
		}
		if (!this.userDataSyncAccountService.account) {
			return { enabled: false, message: '[AutoSync] Suspended until auth token is available.' };
		}
		if (this.userDataSyncStoreService.donotMakeRequestsUntil) {
			return { enabled: false, message: `[AutoSync] Suspended until ${toLocalISOString(this.userDataSyncStoreService.donotMakeRequestsUntil)} because server is not accepting requests until then.` };
		}
		if (this.localRateLimitPause.value) {
			return { enabled: false, message: '[AutoSync] Paused until the local request budget resets.' };
		}
		if (this.meteredConnectionService.isConnectionMetered) {
			return { enabled: false, message: '[AutoSync] Suspended because connection is metered.' };
		}
		return { enabled: true };
	}

	async turnOn(): Promise<void> {
		this.stopDisableMachineEventually();
		await this.deviceRemoval;
		this.lastSyncUrl = this.syncUrl;
		this.updateEnablement(true);
	}

	async turnOff(everywhere: boolean, softTurnOffOnError?: boolean, donotRemoveMachine?: boolean): Promise<void> {
		if (everywhere) {
			this.turningOffEverywhere = true;
		}
		try {
			if (everywhere) {
				const account = this.syncAccountBinding();
				await this.autoSync.value?.drain();
				await this.deviceRemoval;
				if (!account || account !== this.syncAccountBinding()) {
					throw new Error(localize('sync account changed', "The sync account changed. Try turning off sync again."));
				}
				await this.userDataSyncService.resetRemote(true);
				this.stopDisableMachineEventually();
			} else if (softTurnOffOnError && !donotRemoveMachine && this.userDataSyncAccountService.account) {
				await this.userDataSyncMachinesService.removeCurrentMachine();
			}

			// Disable Auto Sync
			this.updateEnablement(false);
			if (!everywhere && !softTurnOffOnError && !donotRemoveMachine && this.userDataSyncAccountService.account) {
				this.disableMachineEventually(0);
			}

			// Reset Session
			this.storageService.remove(sessionIdKey, StorageScope.APPLICATION);

			// Reset
			await this.userDataSyncService.resetLocal();
		} catch (error) {
			this.logService.error(error);
			if (softTurnOffOnError) {
				this.updateEnablement(false);
			} else {
				throw error;
			}
		} finally {
			if (everywhere) {
				this.turningOffEverywhere = false;
				this.autoSync.value?.resume();
				this.updateAutoSync();
			}
		}
	}

	private updateEnablement(enabled: boolean): void {
		if (this.userDataSyncEnablementService.isEnabled() !== enabled) {
			this.userDataSyncEnablementService.setEnablement(enabled);
			this.updateAutoSync();
		}
	}

	private hasProductQualityChanged(): boolean {
		return !!this.previousProductQuality && !!this.productQuality && this.previousProductQuality !== this.productQuality;
	}

	private async onDidFinishSync(error: Error | undefined): Promise<void> {
		this.logService.debug('[AutoSync] Sync Finished');
		if (!error) {
			// Sync finished without errors
			this.successiveFailures = 0;
			return;
		}

		// Error while syncing
		const userDataSyncError = UserDataSyncError.toUserDataSyncError(error);

		// Session got expired
		if (userDataSyncError.code === UserDataSyncErrorCode.SessionExpired) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info('[AutoSync] Turned off sync because current session is expired');
		}

		// No plan for sync (the service answered 402: the account is linked, but its plan does not
		// include sync). Turn sync off softly so a downgrade stops retrying on every trigger; the
		// user is told where it matters — when they try to turn sync on, and in the sync log.
		else if (userDataSyncError.code === UserDataSyncErrorCode.PaymentRequired) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info('[AutoSync] Turned off sync because the account plan does not include sync (402).');
		}

		// Turned off from another device
		else if (userDataSyncError.code === UserDataSyncErrorCode.TurnedOff) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info('[AutoSync] Turned off sync because sync is turned off in the cloud');
		}

		// Exceeded Rate Limit on Client
		else if (userDataSyncError.code === UserDataSyncErrorCode.LocalTooManyRequests) {
			const delay = error instanceof LocalSyncRateLimitError ? Math.max(0, error.retryAt - Date.now()) : REQUEST_SESSION_INTERVAL + 1;
			this.localRetryAt = Date.now() + delay;
			this.localRateLimitPause.value = disposableTimeout(() => {
				this.localRateLimitPause.clear();
				this.localRetryAt = undefined;
				this.updateAutoSync();
			}, delay);
			this.updateAutoSync();
		}

		// Exceeded Rate Limit on Server
		else if (userDataSyncError.code === UserDataSyncErrorCode.TooManyRequests) {
			await this.turnOff(false, true /* force soft turnoff on error */,
				true /* do not disable machine because disabling a machine makes request to server and can fail with TooManyRequests */);
			this.disableMachineEventually();
			this.logService.info('[AutoSync] Turned off sync because of making too many requests to server');
		}

		// Method Not Found
		else if (userDataSyncError.code === UserDataSyncErrorCode.MethodNotFound) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info('[AutoSync] Turned off sync because current client is making requests to server that are not supported');
		}

		// Upgrade Required or Gone
		else if (userDataSyncError.code === UserDataSyncErrorCode.UpgradeRequired || userDataSyncError.code === UserDataSyncErrorCode.Gone) {
			await this.turnOff(false, true /* force soft turnoff on error */,
				true /* do not disable machine because disabling a machine makes request to server and can fail with upgrade required or gone */);
			this.disableMachineEventually();
			this.logService.info('[AutoSync] Turned off sync because current client is not compatible with server. Requires client upgrade.');
		}

		// Incompatible Local Content
		else if (userDataSyncError.code === UserDataSyncErrorCode.IncompatibleLocalContent) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info(`[AutoSync] Turned off sync because server has ${userDataSyncError.resource} content with newer version than of client. Requires client upgrade.`);
		}

		// Incompatible Remote Content
		else if (userDataSyncError.code === UserDataSyncErrorCode.IncompatibleRemoteContent) {
			await this.turnOff(false, true /* force soft turnoff on error */);
			this.logService.info(`[AutoSync] Turned off sync because server has ${userDataSyncError.resource} content with older version than of client. Requires server reset.`);
		}

		// Service changed
		else if (userDataSyncError.code === UserDataSyncErrorCode.ServiceChanged || userDataSyncError.code === UserDataSyncErrorCode.DefaultServiceChanged) {

			// Check if default settings sync service has changed in web without changing the product quality
			// Then turn off settings sync and ask user to turn on again
			if (isWeb && userDataSyncError.code === UserDataSyncErrorCode.DefaultServiceChanged && !this.hasProductQualityChanged()) {
				await this.turnOff(false, true /* force soft turnoff on error */);
				this.logService.info('[AutoSync] Turned off sync because default sync service is changed.');
			}

			// Service has changed by the user. So turn off and turn on sync.
			// Show a prompt to the user about service change.
			else {
				await this.turnOff(false, true /* force soft turnoff on error */, true /* do not disable machine */);
				await this.turnOn();
				this.logService.info('[AutoSync] Sync Service changed. Turned off auto sync, reset local state and turned on auto sync.');
			}

		}

		else {
			this.logService.error(userDataSyncError);
			this.successiveFailures++;
		}

		this._onError.fire(userDataSyncError);
	}

	private disableMachineEventually(delay = 10 * 60_000): void {
		const binding = this.syncAccountBinding();
		if (binding) {
			this.storageService.store(disableMachineEventuallyKey, binding, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.scheduleDeviceRemoval(delay);
		}
	}

	private syncAccountBinding(): string | undefined {
		const account = this.userDataSyncAccountService.account;
		const store = this.userDataSyncStoreManagementService.userDataSyncStore;
		return account?.accountId && store ? JSON.stringify([account.authenticationProviderId, account.accountId, store.url.toString()]) : undefined;
	}

	private scheduleDeviceRemoval(delay = 10 * 60_000): void {
		this.deviceRemovalTimer.value = disposableTimeout(() => {
			this.deviceRemovalTimer.clear();
			const pending = this.hasToDisableMachineEventually();
			if (!pending || this.userDataSyncEnablementService.isEnabled() || this.deviceRemoval) {
				return;
			}
			if (!this.syncAccountBinding()) {
				this.scheduleDeviceRemoval();
				return;
			}
			if (pending !== this.syncAccountBinding()) {
				this.stopDisableMachineEventually();
				return;
			}
			const isCurrent = () => !this._store.isDisposed && !this.userDataSyncEnablementService.isEnabled() && pending === this.hasToDisableMachineEventually() && pending === this.syncAccountBinding();
			this.deviceRemoval = this.userDataSyncMachinesService.removeCurrentMachine(undefined, isCurrent).then(() => {
				if (isCurrent()) { this.stopDisableMachineEventually(); }
			}, error => {
				this.logService.warn('[AutoSync] Could not update this device in the cloud. Will retry.', error);
			}).finally(() => {
				this.deviceRemoval = undefined;
				if (!this._store.isDisposed && this.hasToDisableMachineEventually()) { this.scheduleDeviceRemoval(); }
			});
		}, delay);
	}

	private hasToDisableMachineEventually(): string | undefined {
		return this.storageService.get(disableMachineEventuallyKey, StorageScope.APPLICATION);
	}

	private stopDisableMachineEventually(): void {
		this.deviceRemovalTimer.clear();
		this.storageService.remove(disableMachineEventuallyKey, StorageScope.APPLICATION);
	}

	private sources: string[] = [];
	private pendingSyncOptions: SyncOptions | undefined;

	private storePendingResources(): void {
		this.storageService.store(pendingResourcesKey, this.pendingResources.size ? [...this.pendingResources.keys()] : undefined, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	protected setBackgroundSync(background: boolean): void {
		this.syncInterval = background ? backgroundSyncInterval : foregroundSyncInterval;
		this.autoSync.value?.setInterval(this.syncInterval);
	}
	async triggerSync(sources: string[], options?: SyncOptions): Promise<void> {
		if (this.turningOffEverywhere) { return; }
		if (this.autoSync.value === undefined) {
			return this.syncTriggerDelayer.cancel();
		}
		if (options?.retryResource !== undefined) {
			if (this.failedResources.includes(options.retryResource)) {
				await this.autoSync.value.sync('Activity', false, [options.retryResource], options.retryResource);
			}
			return;
		}

		if (options?.skipIfSyncedRecently && this.lastSyncTriggerTime && new Date().getTime() - this.lastSyncTriggerTime < 10_000) {
			this.logService.debug('[AutoSync] Skipping because sync was triggered recently.', sources);
			return;
		}

		this.sources.push(...sources);
		this.updateStatus();
		this.pendingSyncOptions = {
			immediately: this.pendingSyncOptions?.immediately || options?.immediately,
			disableCache: this.pendingSyncOptions?.disableCache || options?.disableCache,
			wake: this.pendingSyncOptions?.wake || options?.wake,
		};
		const activityDelay = this.pendingSyncOptions.wake
			? Math.max(1_000, this.lastSyncTriggerTime === undefined ? 0 : 10_000 - (Date.now() - this.lastSyncTriggerTime))
			: this.getSyncTriggerDelayTime();
		const backoff = this.sources.includes('networkOnline') ? 0 : Math.min(3_000 * this.successiveFailures, 60_000);
		return this.syncTriggerDelayer.trigger(async () => {
			const sources = [...new Set(this.sources)];
			this.sources = [];
			const disableCache = this.pendingSyncOptions?.disableCache ?? false;
			this.pendingSyncOptions = undefined;
			if (this.autoSync.value) {
				await this.autoSync.value.sync('Activity', disableCache, sources);
			}
		}, this.pendingSyncOptions.immediately ? 0 : Math.max(activityDelay, backoff));

	}

	protected flushPendingChanges(): Promise<void> {
		return this.pendingResources.size
			? this.triggerSync([...this.pendingResources.keys()], { immediately: true })
			: Promise.resolve();
	}

	protected getSyncTriggerDelayTime(): number {
		// Keep one deadline for the whole burst so continuous activity cannot postpone it indefinitely.
		return this.lastSyncTriggerTime === undefined ? 3_000 : Math.max(0, minimumActivityInterval - (Date.now() - this.lastSyncTriggerTime));
	}

}

class AutoSync extends Disposable {

	private static readonly INTERVAL_SYNCING = 'Interval';

	private readonly intervalHandler = this._register(new MutableDisposable<IDisposable>());

	private readonly _onDidStartSync = this._register(new Emitter<void>());
	readonly onDidStartSync = this._onDidStartSync.event;

	private readonly _onDidFinishSync = this._register(new Emitter<{ error: Error | undefined; syncedResources?: ReadonlyMap<SyncResource, number>; failedResources?: readonly SyncResource[] }>());
	readonly onDidFinishSync = this._onDidFinishSync.event;

	private manifest: IUserDataManifest | null = null;
	private checkedManifest: IUserDataManifest | null = null;
	private checkedAccount: string | undefined;
	private readonly failedResources = new Set<SyncResource>();
	private fullSyncGeneration = 0;
	private lastFullSyncTime: number | undefined;
	private syncTask: IUserDataSyncTask | undefined;
	private syncPromise: CancelablePromise<void> | undefined;
	private draining = false;

	async drain(): Promise<void> {
		this.draining = true;
		this.intervalHandler.clear();
		await this.syncPromise;
	}

	resume(): void {
		if (this.draining) {
			this.draining = false;
			this.waitUntilNextIntervalAndSync();
		}
	}

	constructor(
		private readonly lastSyncUrl: URI | undefined,
		private interval: number,
		private readonly userDataSyncStoreManagementService: IUserDataSyncStoreManagementService,
		private readonly userDataSyncStoreService: IUserDataSyncStoreService,
		private readonly userDataSyncService: IUserDataSyncService,
		private readonly userDataSyncMachinesService: IUserDataSyncMachinesService,
		private readonly logService: IUserDataSyncLogService,
		private readonly telemetryService: ITelemetryService,
		private readonly storageService: IStorageService,
		private readonly pendingResources: ReadonlyMap<SyncResource, number>,
		private readonly getAccountBinding: () => string | undefined,
	) {
		super();
	}

	requireFullSync(): void {
		this.checkedManifest = null;
		this.fullSyncGeneration++;
	}

	setInterval(interval: number): void {
		if (this.interval !== interval) {
			this.interval = interval;
			if (this.intervalHandler.value) {
				this.waitUntilNextIntervalAndSync();
			}
		}
	}

	start(): void {
		this._register(this.onDidFinishSync(() => this.waitUntilNextIntervalAndSync()));
		this._register(toDisposable(() => {
			if (this.syncPromise) {
				this.syncPromise.cancel();
				this.logService.info('[AutoSync] Cancelled sync that is in progress');
				this.syncPromise = undefined;
			}
			void this.syncTask?.stop().catch(error => this.logService.error(error));
			this.logService.info('[AutoSync] Stopped');
		}));
		this.sync(AutoSync.INTERVAL_SYNCING, false);
	}

	private waitUntilNextIntervalAndSync(): void {
		if (this.draining) { return; }
		this.intervalHandler.value = disposableTimeout(() => {
			this.sync(AutoSync.INTERVAL_SYNCING, false);
			this.intervalHandler.value = undefined;
		}, this.interval);
	}

	sync(reason: string, disableCache: boolean, sources: readonly string[] = [], retryResource?: SyncResource): Promise<void> {
		if (this.draining || this._store.isDisposed) { return Promise.resolve(); }
		const syncPromise = createCancelablePromise(async token => {
			if (this.syncPromise) {
				try {
					// Wait until existing sync is finished
					this.logService.debug('[AutoSync] Waiting until sync is finished.');
					await this.syncPromise;
				} catch (error) {
					if (isCancellationError(error)) {
						// Cancelled => Disposed. Donot continue sync.
						return;
					}
				}
			}
			if (!this.isCancelled(token)) {
				await this.doSync(reason, disableCache, token, sources, retryResource);
			}
		});
		this.syncPromise = syncPromise;
		const clear = () => {
			if (this.syncPromise === syncPromise) {
				this.syncPromise = undefined;
			}
		};
		void syncPromise.then(clear, clear);
		return syncPromise;
	}

	private isCancelled(token: CancellationToken): boolean {
		// The tail can be cancelled while an older cycle is still awaiting I/O.
		return token.isCancellationRequested || this._store.isDisposed;
	}

	private hasSyncServiceChanged(): boolean {
		return this.lastSyncUrl !== undefined && !isEqual(this.lastSyncUrl, this.userDataSyncStoreManagementService.userDataSyncStore?.url);
	}

	private async hasDefaultServiceChanged(): Promise<boolean> {
		const previous = await this.userDataSyncStoreManagementService.getPreviousUserDataSyncStore();
		const current = this.userDataSyncStoreManagementService.userDataSyncStore;
		// check if defaults changed
		return !!current && !!previous &&
			(!isEqual(current.defaultUrl, previous.defaultUrl) ||
				!isEqual(current.insidersUrl, previous.insidersUrl) ||
				!isEqual(current.stableUrl, previous.stableUrl));
	}

	private async doSync(reason: string, disableCache: boolean, token: CancellationToken, sources: readonly string[], retryResource?: SyncResource): Promise<void> {
		const knownSources = sources.filter(source => ['Sync Now', 'resourceEnablement', 'userDataSyncStoreChanged', 'windowFocus', 'windowOpen', 'windowActive', 'systemResume', 'networkOnline', 'settingsEditor', 'keybindingsEditor', 'preferencesEditor'].includes(source) || ALL_SYNC_RESOURCES.some(resource => resource === source));
		this.logService.info(`[AutoSync] Triggered by ${reason}${knownSources.length ? ` (${knownSources.join(', ')})` : ''}`);
		const startRequests = this.userDataSyncStoreService.requestCount;
		const writes = new Set<string>();
		const resourceErrors = new Set<SyncResource>();
		const listener = this.userDataSyncStoreService.onDidWriteResource(resource => writes.add(resource));
		const errorListener = this.userDataSyncService.onSyncErrors(errors => {
			for (const { syncResource } of errors) { resourceErrors.add(syncResource); }
		});
		const pending = new Map(this.pendingResources);
		const account = this.getAccountBinding();
		const fullSyncGeneration = this.fullSyncGeneration;
		const allowPartial = account === this.checkedAccount && reason === 'Activity' && !disableCache
			&& this.lastFullSyncTime !== undefined && Date.now() - this.lastFullSyncTime < this.interval
			&& sources.length > 0 && sources.every(source => wakeSources.has(source) || ALL_SYNC_RESOURCES.some(resource => resource === source));
		const selected = retryResource !== undefined
			? new Set([retryResource])
			: new Set([...pending.keys(), ...ALL_SYNC_RESOURCES.filter(resource => sources.includes(resource))]);

		this._onDidStartSync.fire();

		let error: Error | undefined;
		let processed: ReadonlySet<SyncResource> | undefined;
		try {
			processed = await this.createAndRunSyncTask(disableCache, token, allowPartial && !selected.has(SyncResource.Profiles) ? selected : undefined);
		} catch (e) {
			this.logService.error(e);
			error = e;
			if (!this.isCancelled(token) && UserDataSyncError.toUserDataSyncError(e).code === UserDataSyncErrorCode.MethodNotFound) {
				try {
					this.logService.info('[AutoSync] Client is making invalid requests. Cleaning up data...');
					await this.userDataSyncService.cleanUpRemoteData();
					this.logService.info('[AutoSync] Retrying sync...');
					resourceErrors.clear();
					processed = await this.createAndRunSyncTask(disableCache, token);
					error = undefined;
				} catch (e1) {
					this.logService.error(e1);
					error = e1;
				}
			}
		} finally {
			listener.dispose();
			errorListener.dispose();
			const outcome = this.isCancelled(token) ? 'cancelled' : error ? 'failed' : resourceErrors.size ? 'finished with resource errors' : 'finished';
			this.logService.info(`[AutoSync] Cycle ${outcome}. Store requests during cycle: ${this.userDataSyncStoreService.requestCount - startRequests}. Cloud writes: ${[...writes].join(', ') || 'none'}. Resource errors: ${[...resourceErrors].join(', ') || 'none'}.`);
		}

		const current = !this.isCancelled(token) && fullSyncGeneration === this.fullSyncGeneration && account === this.getAccountBinding();
		const checked = current && !error && !this.userDataSyncService.conflicts.length;
		// The refresh after a missing manifest can return writes that arrived
		// during the initial cycle. Only remember the manifest that was checked.
		this.checkedManifest = checked && this.manifest === this.syncTask?.manifest ? this.manifest : null;
		this.checkedAccount = checked ? account : undefined;
		if (checked) {
			for (const resource of processed ?? this.failedResources) {
				this.failedResources.delete(resource);
			}
		}
		if (current) {
			for (const resource of resourceErrors) {
				this.failedResources.add(resource);
			}
		}
		const syncedResources = checked
			? new Map([...pending].filter(([resource]) => !resourceErrors.has(resource) && (!processed || processed.has(resource))))
			: undefined;
		this._onDidFinishSync.fire({ error, syncedResources, failedResources: current ? [...this.failedResources] : undefined });
	}

	private async createAndRunSyncTask(disableCache: boolean, token: CancellationToken, selected?: ReadonlySet<SyncResource>): Promise<ReadonlySet<SyncResource> | undefined> {
		if (this.isCancelled(token)) {
			return;
		}
		this.syncTask = await this.userDataSyncService.createSyncTask(this.manifest, disableCache);
		if (this.isCancelled(token)) {
			return;
		}
		this.manifest = this.syncTask.manifest;

		// Server has no data but this machine was synced before
		if (this.manifest === null && await this.userDataSyncService.hasPreviouslySynced()) {
			if (this.hasSyncServiceChanged()) {
				if (await this.hasDefaultServiceChanged()) {
					throw new UserDataAutoSyncError(localize('default service changed', "Cannot sync because default service has changed"), UserDataSyncErrorCode.DefaultServiceChanged);
				} else {
					throw new UserDataAutoSyncError(localize('service changed', "Cannot sync because sync service has changed"), UserDataSyncErrorCode.ServiceChanged);
				}
			} else {
				// Sync was turned off in the cloud
				throw new UserDataAutoSyncError(localize('turned off', "Cannot sync because syncing is turned off in the cloud"), UserDataSyncErrorCode.TurnedOff);
			}
		}

		const sessionId = this.storageService.get(sessionIdKey, StorageScope.APPLICATION);
		// Server session is different from client session
		if (sessionId && this.manifest && sessionId !== this.manifest.session) {
			if (this.hasSyncServiceChanged()) {
				if (await this.hasDefaultServiceChanged()) {
					throw new UserDataAutoSyncError(localize('default service changed', "Cannot sync because default service has changed"), UserDataSyncErrorCode.DefaultServiceChanged);
				} else {
					throw new UserDataAutoSyncError(localize('service changed', "Cannot sync because sync service has changed"), UserDataSyncErrorCode.ServiceChanged);
				}
			} else {
				throw new UserDataAutoSyncError(localize('session expired', "Cannot sync because current session is expired"), UserDataSyncErrorCode.SessionExpired);
			}
		}

		if (this.isCancelled(token)) {
			return;
		}
		const machines = await this.userDataSyncMachinesService.getMachines(this.manifest || undefined);
		// Return if cancellation is requested
		if (this.isCancelled(token)) {
			return;
		}

		const currentMachine = machines.find(machine => machine.isCurrent);
		// Check if sync was turned off from other machine
		if (currentMachine?.disabled) {
			// Throw TurnedOff error
			throw new UserDataAutoSyncError(localize('turned off machine', "Cannot sync because syncing is turned off on this machine from another machine."), UserDataSyncErrorCode.TurnedOff);
		}

		const startTime = new Date().getTime();
		// A 304 reuses the manifest object. Only a checked manifest has accounted
		// for every category, including failures still tracked for retry.
		const resources = this.syncTask.canSelectResources && this.checkedManifest !== null && this.checkedManifest === this.manifest ? selected : undefined;
		await this.syncTask.run(resources);
		if (this.isCancelled(token)) {
			return;
		}
		if (!resources) {
			this.lastFullSyncTime = Date.now();
		}
		this.telemetryService.publicLog2<{
			duration: number;
		}, {
			owner: 'sandy081';
			comment: 'Report when running a sync operation';
			duration: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Time taken to run sync operation' };
		}>('settingsSync:sync', { duration: new Date().getTime() - startTime });

		// After syncing, get the manifest if it was not available before
		if (this.manifest === null) {
			try {
				this.manifest = await this.userDataSyncStoreService.manifest(null);
			} catch (error) {
				if (error instanceof LocalSyncRateLimitError) {
					throw error;
				}
				throw new UserDataAutoSyncError(toErrorMessage(error), error instanceof UserDataSyncError ? error.code : UserDataSyncErrorCode.Unknown);
			}
		}

		if (this.isCancelled(token)) {
			return;
		}

		// Update local session id
		if (this.manifest && this.manifest.session !== sessionId) {
			this.storageService.store(sessionIdKey, this.manifest.session, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}

		// Add current machine
		if (!currentMachine) {
			await this.userDataSyncMachinesService.addCurrentMachine(this.manifest || undefined);
		}
		return resources;
	}

	register<T extends IDisposable>(t: T): T {
		return super._register(t);
	}

}
