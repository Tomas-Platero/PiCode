/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { Event } from '../../../base/common/event.js';
import { deepClone } from '../../../base/common/objects.js';
import { dirname, join } from '../../../base/common/path.js';
import { isObject } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService, IFileStat } from '../../files/common/files.js';
import { IStorageService } from '../../storage/common/storage.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { IUserDataProfile } from '../../userDataProfile/common/userDataProfile.js';
import { AbstractSynchroniser, IAcceptResult, IFileResourcePreview, IMergeResult } from './abstractSynchronizer.js';
import { areSame, IMergeResult as IPiProfileFilesMergeResult, merge } from './snippetsMerge.js';
import { Change, IRemoteUserData, ISyncData, IUserDataSyncLocalStoreService, IUserDataSynchroniser, IUserDataSyncLogService, IUserDataSyncEnablementService, IUserDataSyncStoreService, SyncResource, USER_DATA_SYNC_SCHEME } from './userDataSync.js';

/**
 * Synchronises PiCode's own pi profile (`<dist>/data/pi-agent`) so that agents,
 * subagents and skills follow the user across machines.
 *
 * The `agents`, `subagents`, `skills`, `memory`, `chains`, `gentle-ai` and `specpi` subtrees
 * plus the profile's own config files are bundled. The remote content is a JSON document
 * `{ "version": 1, "files": { "<relativePosixPath>": "<fileContent>" } }`. Merging is
 * last-writer-wins per file; a file changed on both sides becomes a whole-file conflict (no
 * line merging). The pi on the PATH (`~/.pi/agent`) is a different product and is never read
 * or written here.
 */

interface IPiProfileSyncContent {
	version: number;
	files: IStringDictionary<string>;
}

interface IPiProfileResourcePreview extends IFileResourcePreview {
	previewResult: IMergeResult;
}

interface IPiProfileAcceptedResourcePreview extends IFileResourcePreview {
	acceptResult: IAcceptResult;
}

const PI_PROFILE_DATA_VERSION = 1;
/** PiCode's own pi profile inside the distribution: `<dist>/data/pi-agent`. */
const PI_PROFILE_DISTRIBUTION_SUBPATH = ['data', 'pi-agent'];
const PI_PROFILE_SYNCED_FOLDERS = ['agents', 'subagents', 'skills', 'memory', 'chains', 'gentle-ai', 'specpi'];
// Root-level config files of the pi profile, synced alongside the folders.
const PI_PROFILE_ROOT_FILES = ['settings.json', 'models.json', 'subagents.json', 'trust.json', 'mcp-adapter.json'];
// Credentials are machine/session-bound (OAuth token rotation breaks across
// machines) and never leave the device.
const EXCLUDED_FILES = new Set(['auth.json', 'auth.json.bak-omniroute-only', 'crashes.json', 'models.json.bak-before-nan', 'models.json.bak-omniroute-only']);
const SKIPPED_FOLDERS = new Set(['node_modules', 'sessions', 'npm', 'bin', 'extensions', 'tmp', 'web-search-cache', 'git', 'image-view', 'intercom', 'fff', 'gentle-agents', 'mcp-oauth']);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_BUNDLE_SIZE = 3 * 1024 * 1024;

export function parsePiProfileSyncContent(syncData: ISyncData): IStringDictionary<string> | null {
	try {
		const content: IPiProfileSyncContent = JSON.parse(syncData.content);
		if (isObject(content) && content.version === PI_PROFILE_DATA_VERSION
			&& isObject(content.files)
			&& Object.values(content.files).every(file => typeof file === 'string')) {
			return content.files;
		}
	} catch { /* ignore */ }
	return null;
}

/**
 * PiCode's own pi profile — `<dist>/data/pi-agent`, the directory beside the running
 * executable that the extension host and the agent host already resolve (`distributionRoot`
 * plus `data/pi-agent`). The pi on the PATH keeps its profile in `~/.pi/agent`; that is a
 * different product and PiCode never reads or writes it, so the cloud sync must not either.
 *
 * Development and tests fall back to the data folder that belongs to the running instance,
 * which is the same layout the portable distribution uses.
 */
function resolvePiProfileFolder(environmentService: INativeEnvironmentService): string {
	if (/picode/i.test(process.execPath)) {
		// Packaged PiCode: dirname(PiCode.exe) is the distribution root.
		return join(dirname(process.execPath), ...PI_PROFILE_DISTRIBUTION_SUBPATH);
	}
	return join(dirname(environmentService.userDataPath), PI_PROFILE_DISTRIBUTION_SUBPATH[1]);
}

export class PiProfileSynchroniser extends AbstractSynchroniser implements IUserDataSynchroniser {

	protected readonly version: number = PI_PROFILE_DATA_VERSION;
	private readonly piProfileFolder: URI;

	constructor(
		profile: IUserDataProfile,
		collection: string | undefined,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IFileService fileService: IFileService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncLocalStoreService userDataSyncLocalStoreService: IUserDataSyncLocalStoreService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IUserDataSyncEnablementService userDataSyncEnablementService: IUserDataSyncEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super({ syncResource: SyncResource.PiProfile, profile }, collection, fileService, environmentService, storageService, userDataSyncStoreService, userDataSyncLocalStoreService, userDataSyncEnablementService, telemetryService, logService, configurationService, uriIdentityService);
		this.piProfileFolder = URI.file(resolvePiProfileFolder(environmentService));
		this.logService.info(`${this.syncResourceLogLabel}: Using pi profile at ${this.piProfileFolder.fsPath}`);
		for (const folder of PI_PROFILE_SYNCED_FOLDERS) {
			this._register(this.fileService.watch(this.extUri.joinPath(this.piProfileFolder, folder)));
		}
		this._register(Event.filter(this.fileService.onDidFilesChange, e => e.affects(this.piProfileFolder))(() => this.triggerLocalChange()));
	}

	protected async generateSyncPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, isRemoteDataFromCurrentMachine: boolean): Promise<IPiProfileResourcePreview[]> {
		const local = await this.getLocalFileContents();
		const localFiles = this.toFileContents(local);
		const remoteFiles: IStringDictionary<string> | null = remoteUserData.syncData ? this.parsePiProfile(remoteUserData.syncData) : null;

		// Use remote data as last sync data if last sync data does not exist and remote data is from same machine
		lastSyncUserData = lastSyncUserData === null && isRemoteDataFromCurrentMachine ? remoteUserData : lastSyncUserData;
		const lastSyncFiles: IStringDictionary<string> | null = lastSyncUserData && lastSyncUserData.syncData ? this.parsePiProfile(lastSyncUserData.syncData) : null;

		if (remoteFiles) {
			this.logService.trace(`${this.syncResourceLogLabel}: Merging remote pi profile with local pi profile...`);
		} else {
			this.logService.trace(`${this.syncResourceLogLabel}: Remote pi profile does not exist. Synchronizing pi profile for the first time.`);
		}

		const mergeResult = merge(localFiles, remoteFiles, lastSyncFiles);
		return this.getResourcePreviews(mergeResult, local, remoteFiles || {}, lastSyncFiles || {});
	}

	protected async hasRemoteChanged(lastSyncUserData: IRemoteUserData): Promise<boolean> {
		const lastSyncFiles: IStringDictionary<string> | null = lastSyncUserData.syncData ? this.parsePiProfile(lastSyncUserData.syncData) : null;
		if (lastSyncFiles === null) {
			return true;
		}
		const local = await this.getLocalFileContents();
		const localFiles = this.toFileContents(local);
		const mergeResult = merge(localFiles, lastSyncFiles, lastSyncFiles);
		return Object.keys(mergeResult.remote.added).length > 0 || Object.keys(mergeResult.remote.updated).length > 0 || mergeResult.remote.removed.length > 0 || mergeResult.conflicts.length > 0;
	}

	protected async getMergeResult(resourcePreview: IPiProfileResourcePreview, _token: CancellationToken): Promise<IMergeResult> {
		return resourcePreview.previewResult;
	}

	protected async getAcceptResult(resourcePreview: IPiProfileResourcePreview, resource: URI, content: string | null | undefined, _token: CancellationToken): Promise<IAcceptResult> {

		/* Accept local resource */
		if (this.extUri.isEqualOrParent(resource, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }))) {
			return {
				content: resourcePreview.fileContent ? resourcePreview.fileContent.value.toString() : null,
				localChange: Change.None,
				remoteChange: resourcePreview.fileContent
					? resourcePreview.remoteContent !== null ? Change.Modified : Change.Added
					: Change.Deleted
			};
		}

		/* Accept remote resource */
		if (this.extUri.isEqualOrParent(resource, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }))) {
			return {
				content: resourcePreview.remoteContent,
				localChange: resourcePreview.remoteContent !== null
					? resourcePreview.fileContent ? Change.Modified : Change.Added
					: Change.Deleted,
				remoteChange: Change.None,
			};
		}

		/* Accept preview resource */
		if (this.extUri.isEqualOrParent(resource, this.syncPreviewFolder)) {
			if (content === undefined) {
				return {
					content: resourcePreview.previewResult.content,
					localChange: resourcePreview.previewResult.localChange,
					remoteChange: resourcePreview.previewResult.remoteChange,
				};
			} else {
				return {
					content,
					localChange: content === null
						? resourcePreview.fileContent !== null ? Change.Deleted : Change.None
						: Change.Modified,
					remoteChange: content === null
						? resourcePreview.remoteContent !== null ? Change.Deleted : Change.None
						: Change.Modified
				};
			}
		}

		throw new Error(`Invalid Resource: ${resource.toString()}`);
	}

	protected async applyResult(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, resourcePreviews: [IPiProfileResourcePreview, IAcceptResult][], force: boolean): Promise<void> {
		const acceptedResourcePreviews: IPiProfileAcceptedResourcePreview[] = resourcePreviews.map(([resourcePreview, acceptResult]) => ({ ...resourcePreview, acceptResult }));
		if (acceptedResourcePreviews.every(({ localChange, remoteChange }) => localChange === Change.None && remoteChange === Change.None)) {
			this.logService.info(`${this.syncResourceLogLabel}: No changes found during synchronizing pi profile.`);
		}

		if (acceptedResourcePreviews.some(({ localChange }) => localChange !== Change.None)) {
			// back up all local pi profile files
			await this.updateLocalBackup(acceptedResourcePreviews);
			await this.updateLocalFiles(acceptedResourcePreviews, force);
		}

		if (acceptedResourcePreviews.some(({ remoteChange }) => remoteChange !== Change.None)) {
			remoteUserData = await this.updateRemotePiProfile(acceptedResourcePreviews, remoteUserData, force);
		}

		if (lastSyncUserData?.ref !== remoteUserData.ref) {
			// update last sync
			this.logService.trace(`${this.syncResourceLogLabel}: Updating last synchronized pi profile...`);
			await this.updateLastSyncUserData(remoteUserData);
			this.logService.info(`${this.syncResourceLogLabel}: Updated last synchronized pi profile`);
		}

		for (const { previewResource } of acceptedResourcePreviews) {
			// Delete the preview
			try {
				await this.fileService.del(previewResource);
			} catch { /* ignore */ }
		}

	}

	private getResourcePreviews(piProfileMergeResult: IPiProfileFilesMergeResult, localFileContent: IStringDictionary<IFileContent>, remoteFiles: IStringDictionary<string>, baseFiles: IStringDictionary<string>): IPiProfileResourcePreview[] {
		const resourcePreviews: Map<string, IPiProfileResourcePreview> = new Map<string, IPiProfileResourcePreview>();
		const previewUri = (key: string): URI => this.extUri.joinPath(this.syncPreviewFolder, key);

		/* Files added remotely -> add locally */
		for (const key of Object.keys(piProfileMergeResult.local.added)) {
			const previewResult: IMergeResult = {
				content: piProfileMergeResult.local.added[key],
				hasConflicts: false,
				localChange: Change.Added,
				remoteChange: Change.None,
			};
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: null,
				fileContent: null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				localContent: null,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteFiles[key],
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files updated remotely -> update locally */
		for (const key of Object.keys(piProfileMergeResult.local.updated)) {
			const previewResult: IMergeResult = {
				content: piProfileMergeResult.local.updated[key],
				hasConflicts: false,
				localChange: Change.Modified,
				remoteChange: Change.None,
			};
			const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteFiles[key],
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files removed remotely -> remove locally */
		for (const key of piProfileMergeResult.local.removed) {
			const previewResult: IMergeResult = {
				content: null,
				hasConflicts: false,
				localChange: Change.Deleted,
				remoteChange: Change.None,
			};
			const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: null,
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files added locally -> add remotely */
		for (const key of Object.keys(piProfileMergeResult.remote.added)) {
			const previewResult: IMergeResult = {
				content: piProfileMergeResult.remote.added[key],
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Added,
			};
			const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: null,
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files updated locally -> update remotely */
		for (const key of Object.keys(piProfileMergeResult.remote.updated)) {
			const previewResult: IMergeResult = {
				content: piProfileMergeResult.remote.updated[key],
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Modified,
			};
			const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteFiles[key],
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files removed locally -> remove remotely */
		for (const key of piProfileMergeResult.remote.removed) {
			const previewResult: IMergeResult = {
				content: null,
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Deleted,
			};
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: null,
				localContent: null,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteFiles[key],
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Files with conflicts */
		for (const key of piProfileMergeResult.conflicts) {
			const previewResult: IMergeResult = {
				content: baseFiles[key] ?? null,
				hasConflicts: true,
				localChange: localFileContent[key] ? Change.Modified : Change.Added,
				remoteChange: remoteFiles[key] ? Change.Modified : Change.Added
			};
			const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
			resourcePreviews.set(key, {
				baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
				baseContent: baseFiles[key] ?? null,
				localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key] || null,
				localContent,
				remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteFiles[key] || null,
				previewResource: previewUri(key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Unmodified files */
		for (const key of Object.keys(localFileContent)) {
			if (!resourcePreviews.has(key)) {
				const previewResult: IMergeResult = {
					content: localFileContent[key] ? localFileContent[key].value.toString() : null,
					hasConflicts: false,
					localChange: Change.None,
					remoteChange: Change.None
				};
				const localContent = localFileContent[key] ? localFileContent[key].value.toString() : null;
				resourcePreviews.set(key, {
					baseResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }),
					baseContent: baseFiles[key] ?? null,
					localResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
					fileContent: localFileContent[key] || null,
					localContent,
					remoteResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
					remoteContent: remoteFiles[key] || null,
					previewResource: previewUri(key),
					previewResult,
					localChange: previewResult.localChange,
					remoteChange: previewResult.remoteChange,
					acceptedResource: previewUri(key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
				});
			}
		}

		return [...resourcePreviews.values()];
	}

	override async resolveContent(uri: URI): Promise<string | null> {
		if (this.extUri.isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }))
			|| this.extUri.isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }))
			|| this.extUri.isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'base' }))
			|| this.extUri.isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' }))) {
			return this.resolvePreviewContent(uri);
		}
		return null;
	}

	async hasLocalData(): Promise<boolean> {
		try {
			const localFiles = await this.getLocalFileContents();
			if (Object.keys(localFiles).length) {
				return true;
			}
		} catch {
			/* ignore error */
		}
		return false;
	}

	private async updateLocalBackup(resourcePreviews: IFileResourcePreview[]): Promise<void> {
		const local: IStringDictionary<IFileContent> = {};
		for (const resourcePreview of resourcePreviews) {
			if (resourcePreview.fileContent) {
				local[this.getKey(resourcePreview.localResource)] = resourcePreview.fileContent;
			}
		}
		await this.backupLocal(this.toSyncContent(this.toFileContents(local)));
	}

	private async updateLocalFiles(resourcePreviews: IPiProfileAcceptedResourcePreview[], force: boolean): Promise<void> {
		for (const { fileContent, acceptResult, localResource, remoteResource, localChange } of resourcePreviews) {
			if (localChange !== Change.None) {
				const key = remoteResource ? this.getKey(remoteResource) : this.getKey(localResource);
				const resource = this.extUri.joinPath(this.piProfileFolder, key);

				// Removed
				if (localChange === Change.Deleted) {
					this.logService.trace(`${this.syncResourceLogLabel}: Deleting pi profile file...`, key);
					await this.fileService.del(resource);
					this.logService.info(`${this.syncResourceLogLabel}: Deleted pi profile file`, key);
				}

				// Added
				else if (localChange === Change.Added) {
					this.logService.trace(`${this.syncResourceLogLabel}: Creating pi profile file...`, key);
					await this.fileService.createFile(resource, VSBuffer.fromString(acceptResult.content!), { overwrite: force });
					this.logService.info(`${this.syncResourceLogLabel}: Created pi profile file`, key);
				}

				// Updated
				else {
					this.logService.trace(`${this.syncResourceLogLabel}: Updating pi profile file...`, key);
					await this.fileService.writeFile(resource, VSBuffer.fromString(acceptResult.content!), force ? undefined : fileContent!);
					this.logService.info(`${this.syncResourceLogLabel}: Updated pi profile file`, key);
				}
			}
		}
	}

	private async updateRemotePiProfile(resourcePreviews: IPiProfileAcceptedResourcePreview[], remoteUserData: IRemoteUserData, forcePush: boolean): Promise<IRemoteUserData> {
		const currentFiles: IStringDictionary<string> = remoteUserData.syncData ? this.parsePiProfile(remoteUserData.syncData) ?? {} : {};
		const newFiles: IStringDictionary<string> = deepClone(currentFiles);

		for (const { acceptResult, localResource, remoteResource, remoteChange } of resourcePreviews) {
			if (remoteChange !== Change.None) {
				const key = localResource ? this.getKey(localResource) : this.getKey(remoteResource);
				if (remoteChange === Change.Deleted) {
					delete newFiles[key];
				} else {
					newFiles[key] = acceptResult.content!;
				}
			}
		}

		if (!areSame(currentFiles, newFiles)) {
			// update remote
			this.logService.trace(`${this.syncResourceLogLabel}: Updating remote pi profile...`);
			remoteUserData = await this.updateRemoteUserData(this.toSyncContent(newFiles), forcePush ? null : remoteUserData.ref);
			this.logService.info(`${this.syncResourceLogLabel}: Updated remote pi profile`);
		}
		return remoteUserData;
	}

	private getKey(resource: URI): string {
		// The preview resource uses the user-data-sync scheme with a `local`/`remote`/`base`
		// authority, while `syncPreviewFolder` is a `file` URI. `relativePath` returns undefined
		// when scheme or authority differ, so comparing against the folder as-is fell back to the
		// basename and flattened every nested file (`memory/MEMORY.md` became `MEMORY.md`), which
		// collided same-named files and silently dropped all but one of them. Match both first.
		const previewFolder = this.syncPreviewFolder.with({ scheme: resource.scheme, authority: resource.authority });
		const relativePath = this.extUri.relativePath(previewFolder, resource);
		return relativePath ? relativePath.replace(/\\/g, '/') : this.extUri.basename(resource);
	}

	private parsePiProfile(syncData: ISyncData): IStringDictionary<string> | null {
		return parsePiProfileSyncContent(syncData);
	}

	private toSyncContent(files: IStringDictionary<string>): string {
		const content: IPiProfileSyncContent = { version: PI_PROFILE_DATA_VERSION, files };
		return JSON.stringify(content);
	}

	private toFileContents(fileContents: IStringDictionary<IFileContent>): IStringDictionary<string> {
		const files: IStringDictionary<string> = {};
		for (const key of Object.keys(fileContents)) {
			files[key] = fileContents[key].value.toString();
		}
		return files;
	}

	private async getLocalFileContents(): Promise<IStringDictionary<IFileContent>> {
		let candidates: { key: string; resource: URI; size: number }[] = [];
		for (const folder of PI_PROFILE_SYNCED_FOLDERS) {
			const folderResource = this.extUri.joinPath(this.piProfileFolder, folder);
			candidates = candidates.concat(await this.collectFiles(folderResource, [folder]));
		}
		// Root-level config files of the pi profile
		for (const fileName of PI_PROFILE_ROOT_FILES) {
			if (EXCLUDED_FILES.has(fileName)) {
				continue;
			}
			const fileResource = this.extUri.joinPath(this.piProfileFolder, fileName);
			try {
				const stat = await this.fileService.stat(fileResource);
				if (!stat.isDirectory) {
					candidates.push({ key: fileName, resource: fileResource, size: stat.size ?? 0 });
				}
			} catch {
				// File does not exist — normal for optional config files.
			}
		}

		// Sort smallest first so that, when the bundle cap is hit, the largest files are skipped
		candidates.sort((a, b) => a.size - b.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

		// One line per sync makes an unexpected empty folder walk visible instead of silently
		// uploading a root-files-only bundle.
		this.logService.info(`${this.syncResourceLogLabel}: Found ${candidates.length} pi profile file(s) to consider under ${this.piProfileFolder.fsPath}`);

		const files: IStringDictionary<IFileContent> = {};
		let total = 0;
		for (const { key, resource, size } of candidates) {
			if (size > MAX_FILE_SIZE) {
				this.logService.warn(`${this.syncResourceLogLabel}: Skipping pi profile file because it is too large (${size} bytes): ${key}`);
				continue;
			}
			if (total + size > MAX_BUNDLE_SIZE) {
				this.logService.warn(`${this.syncResourceLogLabel}: Skipping pi profile file because the bundle limit of ${MAX_BUNDLE_SIZE} bytes would be exceeded: ${key}`);
				continue;
			}
			try {
				const content = await this.fileService.readFile(resource);
				if (content.value.byteLength > MAX_FILE_SIZE) {
					this.logService.warn(`${this.syncResourceLogLabel}: Skipping pi profile file because it is too large: ${key}`);
					continue;
				}
				files[key] = content;
				total += content.value.byteLength;
			} catch (e) {
				this.logService.warn(`${this.syncResourceLogLabel}: Failed to read pi profile file: ${key}`);
				this.logService.error(e);
			}
		}
		return files;
	}

	private async collectFiles(folder: URI, segments: string[]): Promise<{ key: string; resource: URI; size: number }[]> {
		const result: { key: string; resource: URI; size: number }[] = [];
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(folder, { resolveMetadata: true });
		} catch (e) {
			// Folder does not exist
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return result;
			}
			throw e;
		}
		for (const child of stat.children || []) {
			if (SKIPPED_FOLDERS.has(child.name)) {
				continue;
			}
			const path = [...segments, child.name];
			if (child.isDirectory) {
				result.push(...await this.collectFiles(child.resource, path));
			} else if (!child.isSymbolicLink) {
				result.push({ key: path.join('/'), resource: child.resource, size: child.size ?? 0 });
			}
		}
		return result;
	}

}
