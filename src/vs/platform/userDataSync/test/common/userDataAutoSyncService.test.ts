/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { joinPath } from '../../../../base/common/resources.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { IUserDataProfilesService } from '../../../userDataProfile/common/userDataProfile.js';
import { parseSettingsSyncContent } from '../../common/settingsSync.js';
import { UserDataAutoSyncService } from '../../common/userDataAutoSyncService.js';
import { IUserDataSyncEnablementService, IUserDataSyncService, IUserDataSyncStoreService, SyncResource, UserDataAutoSyncError, UserDataSyncErrorCode, UserDataSyncStoreError } from '../../common/userDataSync.js';
import { IUserDataSyncMachinesService } from '../../common/userDataSyncMachines.js';
import { IUserDataSyncAccountService } from '../../common/userDataSyncAccount.js';
import { UserDataSyncClient, UserDataSyncTestServer } from './userDataSyncClient.js';

class ManualStartAutoSyncService extends UserDataAutoSyncService {
	protected override startAutoSync(): boolean { return false; }
	leaveWindow(): Promise<void> { return this.flushPendingChanges(); }
}

class BackgroundAutoSyncService extends UserDataAutoSyncService {
	background(): void { this.setBackgroundSync(true); }
}

class TestUserDataAutoSyncService extends ManualStartAutoSyncService {
	protected override getSyncTriggerDelayTime(): number { return 50; }

	sync(): Promise<void> {
		return this.triggerSync(['sync']);
	}
}

suite('UserDataAutoSyncService', () => {

	const disposableStore = ensureNoDisposablesAreLeakedInTestSuite();

	test('leaving PiCode flushes queued edits early and leaves idle profiles alone', async () => {
		await runWithFakedTimers({}, async () => {
			const server = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(server));
			const receivingClient = disposableStore.add(new UserDataSyncClient(server));
			await client.setUp();
			await receivingClient.setUp();
			const syncService = client.instantiationService.get(IUserDataSyncService);
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			const receivingSync = disposableStore.add(receivingClient.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			await receivingSync.triggerSync(['Sync Now'], { immediately: true });
			server.reset();
			await autoSync.leaveWindow();
			assert.strictEqual(server.requests.length, 0);
			const settings = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const changed = Event.toPromise(Event.filter(syncService.onDidChangeLocal, resource => resource === SyncResource.Settings));
			await client.instantiationService.get(IFileService).writeFile(settings, VSBuffer.fromString('{"editor.fontSize": 23}'));
			await changed;
			const store = client.instantiationService.get(IUserDataSyncStoreService);
			const write = store.writeResource.bind(store);
			const uploadStarted = new DeferredPromise<void>();
			const releaseUpload = new DeferredPromise<void>();
			store.writeResource = async (resource, ...args) => {
				if (resource === SyncResource.Settings) {
					await uploadStarted.complete();
					await releaseUpload.p;
				}
				return write(resource, ...args);
			};
			const start = Date.now();
			const departure = autoSync.leaveWindow();
			await uploadStarted.p;
			const arrival = receivingSync.triggerSync(['windowFocus'], { wake: true });
			await timeout(1_000);
			await releaseUpload.complete();
			await departure;
			assert.ok(Date.now() - start < 3_000);
			assert.strictEqual(server.requests.filter(request => request.type === 'POST' && request.url.endsWith('/settings')).length, 1);
			await arrival;
			const receivedSettings = receivingClient.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const received = await receivingClient.instantiationService.get(IFileService).readFile(receivedSettings);
			assert.strictEqual(JSON.parse(received.value.toString())['editor.fontSize'], 23);
		});
	});

	test('retrying a failed category on an unchanged manifest leaves other failures pending', async () => {
		await runWithFakedTimers({}, async () => {
			const server = new UserDataSyncTestServer(undefined, undefined, true);
			const client = disposableStore.add(new UserDataSyncClient(server));
			const remote = disposableStore.add(new UserDataSyncClient(server));
			await client.setUp();
			await remote.setUp();
			const store = client.instantiationService.get(IUserDataSyncStoreService);
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			const write = store.writeResource.bind(store);
			const failures = new Set<string>([SyncResource.Settings, SyncResource.Keybindings]);
			const attempts: string[] = [];
			store.writeResource = async (resource, ...rest) => {
				attempts.push(resource);
				if (failures.has(resource)) {
					throw new Error('Temporary upload failure');
				}
				return write(resource, ...rest);
			};
			const profile = client.instantiationService.get(IUserDataProfilesService).defaultProfile;
			const files = client.instantiationService.get(IFileService);
			await files.writeFile(profile.settingsResource, VSBuffer.fromString('{"editor.fontSize": 23}'));
			await files.writeFile(profile.keybindingsResource, VSBuffer.fromString('[{"key":"ctrl+k","command":"example.command"}]'));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			assert.deepStrictEqual((await autoSync.getStatus()).failedResources, [SyncResource.Settings, SyncResource.Keybindings]);
			failures.delete(SyncResource.Settings);
			attempts.length = 0;
			await autoSync.triggerSync([SyncResource.Settings], { retryResource: SyncResource.Settings });
			assert.deepStrictEqual(attempts, [SyncResource.Settings]);
			assert.deepStrictEqual((await autoSync.getStatus()).failedResources, [SyncResource.Keybindings]);

			await remote.sync();
			const snippets = remote.instantiationService.get(IUserDataProfilesService).defaultProfile.snippetsHome;
			const snippet = 'trial.json';
			const snippetContent = '{"trial":{"prefix":"trial","body":"remote change"}}';
			await remote.instantiationService.get(IFileService).writeFile(joinPath(snippets, snippet), VSBuffer.fromString(snippetContent));
			await remote.sync();
			failures.clear();
			await autoSync.triggerSync([SyncResource.Keybindings], { retryResource: SyncResource.Keybindings });
			assert.strictEqual((await autoSync.getStatus()).failedResources, undefined);
			const received = await files.readFile(joinPath(profile.snippetsHome, snippet));
			assert.deepStrictEqual(JSON.parse(received.value.toString()), JSON.parse(snippetContent));
		});
	});

	test('disposing sync cancels a cycle awaiting a manifest even with another cycle queued', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			const service = client.instantiationService.get(IUserDataSyncService);
			const started = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			let runs = 0;
			service.createSyncTask = async () => {
				await started.complete();
				await release.p;
				return { manifest: null, run: async () => { runs++; }, stop: async () => { } };
			};
			const autoSync = disposableStore.add(client.instantiationService.createInstance(BackgroundAutoSyncService));
			await started.p;
			const queued = autoSync.triggerSync(['Sync Now'], { immediately: true }).catch(() => undefined);
			await timeout(20);
			autoSync.dispose();
			await release.complete();
			await queued;
			await timeout(20);
			assert.strictEqual(runs, 0);
		});
	});

	test('background sync checks once in fifteen minutes', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			await client.sync();
			const autoSync = disposableStore.add(client.instantiationService.createInstance(BackgroundAutoSyncService));
			try {
				await autoSync.triggerSync(['Sync Now'], { immediately: true });
				client.testServer.reset();
				autoSync.background();
				await timeout(14 * 60_000);
				assert.strictEqual(client.testServer.requests.length, 0);
				await timeout(61_000);
				assert.strictEqual(client.testServer.requests.filter(request => request.url.endsWith('/v1/manifest')).length, 1);
			} finally {
				autoSync.dispose();
			}
		});
	});

	test('focus and reconnect pull a change from another computer in one prompt check', async () => {
		await runWithFakedTimers({}, async () => {
			const server = new UserDataSyncTestServer();
			const first = disposableStore.add(new UserDataSyncClient(server));
			const second = disposableStore.add(new UserDataSyncClient(server));
			await first.setUp();
			await second.setUp();
			await first.sync();
			const autoSync = disposableStore.add(second.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			const firstFile = first.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const secondFile = second.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const startedAt = Date.now();
			await first.instantiationService.get(IFileService).writeFile(firstFile, VSBuffer.fromString('{"editor.fontSize": 19}'));
			await first.sync();
			server.reset();
			await Promise.all([
				autoSync.triggerSync(['windowFocus'], { wake: true }),
				autoSync.triggerSync(['networkOnline'], { wake: true }),
			]);
			assert.match((await second.instantiationService.get(IFileService).readFile(secondFile)).value.toString(), /"editor.fontSize":\s*19/);
			assert.ok(Date.now() - startedAt < 15_000);
			assert.strictEqual(server.requests.filter(request => request.url.endsWith('/v1/manifest')).length, 1);
		});
	});

	test('remembers unsent categories across auto sync restarts and clears them after upload', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			const syncService = client.instantiationService.get(IUserDataSyncService);
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			const settings = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const changed = Event.toPromise(Event.filter(syncService.onDidChangeLocal, resource => resource === SyncResource.Settings));
			await client.instantiationService.get(IFileService).writeFile(settings, VSBuffer.fromString('{"editor.fontSize": 21}'));
			await changed;
			assert.strictEqual((await autoSync.getStatus()).state, 'pending');
			autoSync.dispose();

			const restarted = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			assert.strictEqual((await restarted.getStatus()).state, 'pending');
			client.testServer.reset();
			await restarted.triggerSync(['networkOnline'], { wake: true });
			assert.deepStrictEqual(client.testServer.requests.filter(request => request.type === 'POST').map(request => request.url), [
				`${client.testServer.url}/v1/resource/settings`,
			]);
			assert.strictEqual((await restarted.getStatus()).state, 'idle');
		});
	});

	test('checks only the local categories after a successful unchanged manifest', async () => {
		await runWithFakedTimers({}, async () => {
			const server = new UserDataSyncTestServer(undefined, undefined, true);
			const first = disposableStore.add(new UserDataSyncClient(server));
			const second = disposableStore.add(new UserDataSyncClient(server));
			await first.setUp();
			await second.setUp();
			await first.sync();
			const syncService = second.instantiationService.get(IUserDataSyncService);
			const createTask = syncService.createSyncTask.bind(syncService);
			const passes: (SyncResource[] | undefined)[] = [];
			syncService.createSyncTask = async (manifest, disableCache) => {
				const task = await createTask(manifest, disableCache);
				return {
					...task,
					run: async resources => {
						passes.push(resources && [...resources]);
						await task.run(resources);
					},
				};
			};
			const autoSync = disposableStore.add(second.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			await autoSync.triggerSync([SyncResource.Settings]);
			await autoSync.triggerSync(['windowFocus'], { wake: true });
			await timeout(5 * 60_000);
			await autoSync.triggerSync(['windowFocus'], { wake: true });
			const settings = first.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			await first.instantiationService.get(IFileService).writeFile(settings, VSBuffer.fromString('{"editor.fontSize": 22}'));
			await first.sync();
			await autoSync.triggerSync(['windowFocus'], { wake: true });
			assert.deepStrictEqual(passes, [undefined, undefined, [SyncResource.Settings], [], undefined, undefined]);
		});
	});

	test('an older upload does not clear a newer pending edit', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			const syncService = client.instantiationService.get(IUserDataSyncService);
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			const originalTask = syncService.createSyncTask.bind(syncService);
			const uploaded = new DeferredPromise<void>();
			const finish = new DeferredPromise<void>();
			syncService.createSyncTask = async (manifest, disableCache) => {
				const task = await originalTask(manifest, disableCache);
				return {
					...task,
					run: async resources => {
						await task.run(resources);
						await uploaded.complete();
						await finish.p;
					},
				};
			};
			const fileService = client.instantiationService.get(IFileService);
			const settings = client.instantiationService.get(IUserDataProfilesService).defaultProfile.settingsResource;
			const changeSettings = async (fontSize: number) => {
				const changed = Event.toPromise(Event.filter(syncService.onDidChangeLocal, resource => resource === SyncResource.Settings));
				await fileService.writeFile(settings, VSBuffer.fromString(JSON.stringify({ 'editor.fontSize': fontSize })));
				await changed;
			};

			await changeSettings(20);
			const running = autoSync.triggerSync(['Sync Now'], { immediately: true });
			await uploaded.p;
			await changeSettings(21);
			await finish.complete();
			await running;

			assert.strictEqual((await autoSync.getStatus()).state, 'pending');
			syncService.createSyncTask = originalTask;
			await autoSync.triggerSync(['Sync Now'], { immediately: true });
			assert.strictEqual((await autoSync.getStatus()).state, 'idle');
			const content = await client.instantiationService.get(IUserDataSyncStoreService).readResource(SyncResource.Settings, null);
			assert.ok(content.content);
			const revision = parseSettingsSyncContent(JSON.parse(content.content).content);
			assert.strictEqual(JSON.parse(revision.settings)['editor.fontSize'], 21);
		});
	});

	test('paces background activity without losing the next sync', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			await client.sync();
			client.testServer.reset();
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync([SyncResource.Settings]);
			const start = Date.now();
			const burst = Promise.all([
				autoSync.triggerSync([SyncResource.Settings]),
				autoSync.triggerSync([SyncResource.GlobalState]),
			]);
			assert.strictEqual((await autoSync.getStatus()).state, 'pending');
			await burst;
			assert.strictEqual((await autoSync.getStatus()).state, 'idle');
			assert.ok(Date.now() - start >= 29_000);
			assert.strictEqual(client.testServer.requests.filter(request => request.url.endsWith('/v1/manifest')).length, 2);
		});
	});

	test('waits for an active cycle before clearing cloud data', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			const syncService = client.instantiationService.get(IUserDataSyncService);
			const started = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			syncService.createSyncTask = async () => ({
				manifest: null,
				run: async () => { await started.complete(); await release.p; },
				stop: async () => { throw new Error('The active write must be allowed to finish'); },
			});
			let cleared = false;
			syncService.resetRemote = async () => { cleared = true; };
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			const cycle = autoSync.triggerSync([SyncResource.Settings]);
			await started.p;
			const turningOff = autoSync.turnOff(true);
			await timeout(100);
			assert.strictEqual(cleared, false);
			await release.complete();
			await Promise.all([cycle, turningOff]);
			assert.strictEqual(cleared, true);
		});
	});

	test('does not replay device removal for a different account', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			Object.defineProperty(client.instantiationService.get(IEnvironmentService), 'sync', { value: undefined });
			client.instantiationService.get(IUserDataSyncEnablementService).setEnablement(true);
			const account = client.instantiationService.get(IUserDataSyncAccountService);
			let attempts = 0;
			client.instantiationService.get(IUserDataSyncMachinesService).removeCurrentMachine = async () => {
				attempts++;
				throw new Error('Offline');
			};
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.turnOff(false);
			await timeout(100);
			await account.updateAccount({ authenticationProviderId: 'authenticationProviderId', accountId: 'other-account', token: 'other-token' });
			await timeout(10 * 60_000);
			assert.strictEqual(attempts, 1);
		});
	});

	test('resumes automatically after reaching the local request limit', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			const autoSync = disposableStore.add(client.instantiationService.createInstance(class extends TestUserDataAutoSyncService {
				declare private started: boolean | undefined;
				protected override startAutoSync(): boolean {
					const isResuming = this.started === true;
					this.started = true;
					return isResuming;
				}
			}));
			const onError = Event.toPromise(autoSync.onError);
			const syncStore = client.instantiationService.get(IUserDataSyncStoreService);
			await syncStore.manifest(null);
			await timeout(60_000);
			while (client.testServer.requests.length < 100) {
				await syncStore.manifest(null);
			}
			await autoSync.sync();
			assert.strictEqual((await onError).code, UserDataSyncErrorCode.LocalTooManyRequests);
			const paused = await autoSync.getStatus();
			assert.strictEqual(paused.state, 'paused');
			assert.ok(paused.retryAt && paused.retryAt > Date.now());
			const fileService = client.instantiationService.get(IFileService);
			const { settingsResource } = client.instantiationService.get(IUserDataProfilesService).defaultProfile;
			await fileService.writeFile(settingsResource, VSBuffer.fromString('{"editor.fontSize": 17}'));
			await timeout(60_000);
			assert.strictEqual(client.testServer.requests.length, 100);
			await timeout(180_100);
			assert.ok(client.testServer.requests.length > 100);
			const remote = await client.read(SyncResource.Settings);
			const { settings } = JSON.parse(JSON.parse(remote.content!).content);
			assert.strictEqual(JSON.parse(settings)['editor.fontSize'], 17);
		});
	});

	test('turns off locally while offline and retries updating this device', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			Object.defineProperty(client.instantiationService.get(IEnvironmentService), 'sync', { value: undefined });
			const enablement = client.instantiationService.get(IUserDataSyncEnablementService);
			enablement.setEnablement(true);
			const machines = client.instantiationService.get(IUserDataSyncMachinesService);
			let attempts = 0;
			machines.removeCurrentMachine = async () => {
				if (++attempts === 1) { throw new Error('Offline'); }
			};
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.turnOff(false);
			assert.strictEqual(enablement.isEnabled(), false);
			await timeout(10 * 60_000 + 100);
			assert.strictEqual(attempts, 2);
		});
	});

	test('keeps sync enabled when the server cannot confirm turning off everywhere', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			Object.defineProperty(client.instantiationService.get(IEnvironmentService), 'sync', { value: undefined });
			const enablement = client.instantiationService.get(IUserDataSyncEnablementService);
			enablement.setEnablement(true);
			client.instantiationService.get(IUserDataSyncStoreService).clear = async () => { throw new Error('Offline'); };
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await assert.rejects(autoSync.turnOff(true), /Offline/);
			assert.strictEqual(enablement.isEnabled(), true);
		});
	});

	test('keeps Sync Now immediate and uncached when activity arrives in the same burst', async () => {
		await runWithFakedTimers({}, async () => {
			const client = disposableStore.add(new UserDataSyncClient());
			await client.setUp();
			await client.sync();
			client.testServer.reset();
			const autoSync = disposableStore.add(client.instantiationService.createInstance(ManualStartAutoSyncService));
			await autoSync.triggerSync([SyncResource.Settings]);
			const start = Date.now();
			await Promise.all([
				autoSync.triggerSync(['Sync Now'], { immediately: true, disableCache: true }),
				autoSync.triggerSync([SyncResource.Settings]),
			]);
			assert.ok(Date.now() - start < 3_000);
			const manifests = client.testServer.requestsWithAllHeaders.filter(request => request.url.endsWith('/v1/manifest'));
			assert.strictEqual(manifests.at(-1)?.headers?.['Cache-Control'], 'no-cache');
		});
	});

	test('test auto sync with sync resource change triggers sync', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();

			// Sync once and reset requests
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();
			target.reset();

			const testObject: UserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Trigger auto sync with settings change
			await testObject.triggerSync([SyncResource.Settings]);

			// Filter out machine requests
			const actual = target.requests.filter(request => !request.url.startsWith(`${target.url}/v1/resource/machines`));

			// Make sure only one manifest request is made
			assert.deepStrictEqual(actual, [{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} }]);
		});
	});

	test('test auto sync with sync resource change triggers sync for every change', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();

			// Sync once and reset requests
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();
			target.reset();

			const testObject: UserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Trigger auto sync with settings change multiple times
			for (let counter = 0; counter < 2; counter++) {
				await testObject.triggerSync([SyncResource.Settings]);
			}

			// Filter out machine requests
			const actual = target.requests.filter(request => !request.url.startsWith(`${target.url}/v1/resource/machines`));

			assert.deepStrictEqual(actual, [
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} },
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } }
			]);
		});
	});

	test('test auto sync with non sync resource change triggers sync', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();

			// Sync once and reset requests
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();
			target.reset();

			const testObject: UserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Trigger auto sync with window focus once
			await testObject.triggerSync(['windowFocus']);

			// Filter out machine requests
			const actual = target.requests.filter(request => !request.url.startsWith(`${target.url}/v1/resource/machines`));

			// Make sure only one manifest request is made
			assert.deepStrictEqual(actual, [{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} }]);
		});
	});

	test('test auto sync with non sync resource change does not trigger continuous syncs', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();

			// Sync once and reset requests
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();
			target.reset();

			const testObject: UserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Trigger auto sync with window focus multiple times
			for (let counter = 0; counter < 2; counter++) {
				await testObject.triggerSync(['windowFocus'], { skipIfSyncedRecently: true });
			}

			// Filter out machine requests
			const actual = target.requests.filter(request => !request.url.startsWith(`${target.url}/v1/resource/machines`));

			// Make sure only one manifest request is made
			assert.deepStrictEqual(actual, [{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} }]);
		});
	});

	test('test first auto sync requests', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			await testObject.sync();

			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} },
				// Machines
				{ type: 'GET', url: `${target.url}/v1/resource/machines/latest`, headers: {} },
				// Settings
				{ type: 'POST', url: `${target.url}/v1/resource/settings`, headers: { 'If-Match': '0' } },
				// Keybindings
				{ type: 'POST', url: `${target.url}/v1/resource/keybindings`, headers: { 'If-Match': '0' } },
				// Snippets
				{ type: 'POST', url: `${target.url}/v1/resource/snippets`, headers: { 'If-Match': '0' } },
				// Tasks
				{ type: 'POST', url: `${target.url}/v1/resource/tasks`, headers: { 'If-Match': '0' } },
				// Global state
				{ type: 'POST', url: `${target.url}/v1/resource/globalState`, headers: { 'If-Match': '0' } },
				// Prompts
				{ type: 'POST', url: `${target.url}/v1/resource/prompts`, headers: { 'If-Match': '0' } },
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: {} },
				// Machines
				{ type: 'POST', url: `${target.url}/v1/resource/machines`, headers: { 'If-Match': '0' } }
			]);
		});
	});

	test('test further auto sync requests without changes', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Sync once and reset requests
			await testObject.sync();
			target.reset();

			await testObject.sync();

			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } }
			]);
		});
	});

	test('test further auto sync requests with changes', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Sync once and reset requests
			await testObject.sync();
			target.reset();

			// Do changes in the client
			const fileService = client.instantiationService.get(IFileService);
			const environmentService = client.instantiationService.get(IEnvironmentService);
			const userDataProfilesService = client.instantiationService.get(IUserDataProfilesService);
			await fileService.writeFile(userDataProfilesService.defaultProfile.settingsResource, VSBuffer.fromString(JSON.stringify({ 'editor.fontSize': 14 })));
			await fileService.writeFile(userDataProfilesService.defaultProfile.keybindingsResource, VSBuffer.fromString(JSON.stringify([{ 'command': 'abcd', 'key': 'cmd+c' }])));
			await fileService.writeFile(joinPath(userDataProfilesService.defaultProfile.snippetsHome, 'html.json'), VSBuffer.fromString(`{}`));
			await fileService.writeFile(joinPath(userDataProfilesService.defaultProfile.promptsHome, 'h1.prompt.md'), VSBuffer.fromString(' '));
			await fileService.writeFile(environmentService.argvResource, VSBuffer.fromString(JSON.stringify({ 'locale': 'de' })));
			await testObject.sync();

			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } },
				// Settings
				{ type: 'POST', url: `${target.url}/v1/resource/settings`, headers: { 'If-Match': '1' } },
				// Keybindings
				{ type: 'POST', url: `${target.url}/v1/resource/keybindings`, headers: { 'If-Match': '1' } },
				// Snippets
				{ type: 'POST', url: `${target.url}/v1/resource/snippets`, headers: { 'If-Match': '1' } },
				// Global state
				{ type: 'POST', url: `${target.url}/v1/resource/globalState`, headers: { 'If-Match': '1' } },
				// Prompts
				{ type: 'POST', url: `${target.url}/v1/resource/prompts`, headers: { 'If-Match': '1' } },
			]);
		});
	});

	test('test auto sync send execution id header', async () => {
		await runWithFakedTimers({}, async () => {
			// Setup the client
			const target = new UserDataSyncTestServer();
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(client.instantiationService.createInstance(TestUserDataAutoSyncService));

			// Sync once and reset requests
			await testObject.sync();
			target.reset();

			await testObject.sync();

			for (const request of target.requestsWithAllHeaders) {
				const hasExecutionIdHeader = request.headers && request.headers['X-Execution-Id'] && request.headers['X-Execution-Id'].length > 0;
				if (request.url.startsWith(`${target.url}/v1/resource/machines`)) {
					assert.ok(!hasExecutionIdHeader, `Should not have execution header: ${request.url}`);
				} else {
					assert.ok(hasExecutionIdHeader, `Should have execution header: ${request.url}`);
				}
			}
		});
	});

	test('test delete on one client throws turned off error on other client while syncing', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer();

			// Set up and sync from the client
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));
			await testObject.sync();

			// Reset from the first client
			await client.instantiationService.get(IUserDataSyncService).reset();

			// Sync from the test client
			target.reset();

			const errorPromise = Event.toPromise(testObject.onError);
			await testObject.sync();

			const e = await errorPromise;
			assert.ok(e instanceof UserDataAutoSyncError);
			assert.deepStrictEqual((<UserDataAutoSyncError>e).code, UserDataSyncErrorCode.TurnedOff);
			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } },
				// Machine
				{ type: 'GET', url: `${target.url}/v1/resource/machines/latest`, headers: { 'If-None-Match': '1' } },
			]);
		});
	});

	test('test disabling the machine turns off sync', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer();

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));
			await testObject.sync();

			// Disable current machine
			const userDataSyncMachinesService = testClient.instantiationService.get(IUserDataSyncMachinesService);
			const machines = await userDataSyncMachinesService.getMachines();
			const currentMachine = machines.find(m => m.isCurrent)!;
			await userDataSyncMachinesService.setEnablements([[currentMachine.id, false]]);

			target.reset();

			const errorPromise = Event.toPromise(testObject.onError);
			await testObject.sync();

			const e = await errorPromise;
			assert.ok(e instanceof UserDataAutoSyncError);
			assert.deepStrictEqual((<UserDataAutoSyncError>e).code, UserDataSyncErrorCode.TurnedOff);
			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } },
				// Machine
				{ type: 'GET', url: `${target.url}/v1/resource/machines/latest`, headers: { 'If-None-Match': '2' } },
				{ type: 'POST', url: `${target.url}/v1/resource/machines`, headers: { 'If-Match': '2' } },
			]);
		});
	});

	test('test removing the machine adds machine back', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer();

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));
			await testObject.sync();

			// Remove current machine
			await testClient.instantiationService.get(IUserDataSyncMachinesService).removeCurrentMachine();

			target.reset();

			await testObject.sync();
			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } },
				// Machine
				{ type: 'POST', url: `${target.url}/v1/resource/machines`, headers: { 'If-Match': '2' } },
			]);
		});
	});

	test('test creating new session from one client throws session expired error on another client while syncing', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer();

			// Set up and sync from the client
			const client = disposableStore.add(new UserDataSyncClient(target));
			await client.setUp();
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));
			await testObject.sync();

			// Reset from the first client
			await client.instantiationService.get(IUserDataSyncService).reset();

			// Sync again from the first client to create new session
			await (await client.instantiationService.get(IUserDataSyncService).createSyncTask(null)).run();

			// Sync from the test client
			target.reset();

			const errorPromise = Event.toPromise(testObject.onError);
			await testObject.sync();

			const e = await errorPromise;
			assert.ok(e instanceof UserDataAutoSyncError);
			assert.deepStrictEqual((<UserDataAutoSyncError>e).code, UserDataSyncErrorCode.SessionExpired);
			assert.deepStrictEqual(target.requests, [
				// Manifest
				{ type: 'GET', url: `${target.url}/v1/manifest`, headers: { 'If-None-Match': '1' } },
				// Machine
				{ type: 'GET', url: `${target.url}/v1/resource/machines/latest`, headers: { 'If-None-Match': '1' } },
			]);
		});
	});

	test('test rate limit on server', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer(5);

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));

			const errorPromise = Event.toPromise(testObject.onError);
			while (target.requests.length < 5) {
				await testObject.sync();
			}

			const e = await errorPromise;
			assert.ok(e instanceof UserDataSyncStoreError);
			assert.deepStrictEqual((<UserDataSyncStoreError>e).code, UserDataSyncErrorCode.TooManyRequests);
		});
	});

	test('test auto sync is suspended when server donot accepts requests', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer(5, 1);

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));

			while (target.requests.length < 5) {
				await testObject.sync();
			}

			target.reset();
			await testObject.sync();

			assert.deepStrictEqual(target.requests, []);
		});
	});

	test('test cache control header with no cache is sent when triggered with disable cache option', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer(5, 1);

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));

			await testObject.triggerSync(['some reason'], { disableCache: true });
			assert.strictEqual(target.requestsWithAllHeaders[0].headers!['Cache-Control'], 'no-cache');
		});
	});

	test('test cache control header is not sent when triggered without disable cache option', async () => {
		await runWithFakedTimers({}, async () => {
			const target = new UserDataSyncTestServer(5, 1);

			// Set up and sync from the test client
			const testClient = disposableStore.add(new UserDataSyncClient(target));
			await testClient.setUp();
			const testObject: TestUserDataAutoSyncService = disposableStore.add(testClient.instantiationService.createInstance(TestUserDataAutoSyncService));

			await testObject.triggerSync(['some reason']);
			assert.strictEqual(target.requestsWithAllHeaders[0].headers!['Cache-Control'], undefined);
		});
	});

});
