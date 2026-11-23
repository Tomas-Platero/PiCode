/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { RunOnceScheduler } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostService } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { IStorageService } from '../../storage/common/storage.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { UserDataAutoSyncService as BaseUserDataAutoSyncService } from '../common/userDataAutoSyncService.js';
import { IUserDataSyncEnablementService, IUserDataSyncLogService, IUserDataSyncService, IUserDataSyncStoreManagementService, IUserDataSyncStoreService } from '../common/userDataSync.js';
import { IUserDataSyncAccountService } from '../common/userDataSyncAccount.js';
import { IUserDataSyncMachinesService } from '../common/userDataSyncMachines.js';

export class UserDataAutoSyncService extends BaseUserDataAutoSyncService {

	constructor(
		@IProductService productService: IProductService,
		@IUserDataSyncStoreManagementService userDataSyncStoreManagementService: IUserDataSyncStoreManagementService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncEnablementService userDataSyncEnablementService: IUserDataSyncEnablementService,
		@IUserDataSyncService userDataSyncService: IUserDataSyncService,
		@INativeHostService nativeHostService: INativeHostService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IUserDataSyncAccountService authTokenService: IUserDataSyncAccountService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IUserDataSyncMachinesService userDataSyncMachinesService: IUserDataSyncMachinesService,
		@IStorageService storageService: IStorageService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
	) {
		super(productService, userDataSyncStoreManagementService, userDataSyncStoreService, userDataSyncEnablementService, userDataSyncService, logService, authTokenService, telemetryService, userDataSyncMachinesService, storageService, meteredConnectionService);

		let inBackground = false;
		const foreground = this._register(new Emitter<string>());
		const background = this._register(new RunOnceScheduler(() => {
			inBackground = true;
			this.setBackgroundSync(true);
			void this.flushPendingChanges().catch(error => logService.error(error));
		}, 1_000));
		this._register(nativeHostService.onDidBlurMainOrAuxiliaryWindow(() => background.schedule()));
		this._register(nativeHostService.onDidFocusMainOrAuxiliaryWindow(() => {
			background.cancel();
			if (inBackground) {
				inBackground = false;
				this.setBackgroundSync(false);
				foreground.fire('windowFocus');
			}
		}));
		this._register(Event.debounce<string, string[]>(Event.any<string>(
			foreground.event,
			Event.map(nativeHostService.onDidOpenMainWindow, () => 'windowOpen'),
			Event.map(nativeHostService.onDidResumeOS, () => 'systemResume'),
		), (last, source) => last ? [...last, source] : [source], 500)(sources => {
			void this.triggerSync(sources, { wake: true }).catch(error => logService.error(error));
		}));
	}

}
