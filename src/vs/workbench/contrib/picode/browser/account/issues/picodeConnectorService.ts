/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { timeout } from '../../../../../../base/common/async.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { asText, IRequestService } from '../../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IURLService } from '../../../../../../platform/url/common/url.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { PICODE_AUTH_PROVIDER_ID, PICODE_PLAN_STORAGE_KEY } from '../../picodeAccountProvider.js';
import {
	atlassianAuthorizeUrl, connectorCodeFromCallback, IPicodeConnection, IPicodeDeviceCode,
	parseAtlassianSites, parseDeviceCode, parseDevicePoll, PicodeConnectorService, PicodeDevicePoll,
} from './picodeConnectorAuth.js';
import {
	buildGithubUpdate, buildJiraUpdate, GITHUB_STATUSES, IPicodeBoardIssue, IPicodeBoardStatus, IPicodeGithubPatch, IPicodeJiraPatch, IPicodeNamed, IPicodeProjectView, isJiraProjectKey, mapGithubBoardIssues, mapJiraBoardIssues, mapJiraProject,
	mapEditMetaPriorities, mapEditMetaTypes, mapGithubAssignees, mapGithubLabelNames, jiraKeyFromBranch, mapJiraBoardColumns, mapJiraProjectList, mapJiraUsers, mapJiraStatuses, mapNamedList, mapProjectIssueTypes, nextJiraPageToken, parseGithubRepoRef, pickJiraBoardId, pickTransition,
} from './picodeIssueBoard.js';
import { IPicodeIssue, IPicodeRepo, mapGithubIssues, mapGithubRepos, mapJiraIssues, originFromGitConfig, parseGithubRemote, PicodeIssueSource } from './picodeIssueSources.js';

/**
 * How the last attempt to read issues ended. The page turns each into one plain sentence.
 * `notInstalled`: GitHub is connected, but the PiCode app is installed on none of the person's accounts, so no repository is visible.
 * `notVisible`: the app is installed, but not on the repository that was asked for.
 */
export type PicodeIssuesState = 'ok' | 'notConnected' | 'reconnect' | 'offline' | 'rateLimited' | 'notPro' | 'notInstalled' | 'notVisible';

/** What a list is narrowed to: one GitHub repository (`owner/repo`, lower case) or one Jira space (its key). Nothing means everything. */
export interface IPicodeIssuesScope {
	readonly repo?: string;
	readonly project?: string;
}

export interface IPicodeIssuesResult {
	readonly state: PicodeIssuesState;
	readonly issues: readonly IPicodeIssue[];
	/** True when `issues` is the last list that was read, shown because the new read failed. */
	readonly stale: boolean;
}

/** The last answer to `listIssues`, to show at once while a new one is asked for. */
export interface IPicodeKnownIssues {
	readonly result: IPicodeIssuesResult;
	/** True when it is a good list read a moment ago: no need to ask again yet. */
	readonly fresh: boolean;
}

export interface IPicodeProjectViewResult {
	readonly state: PicodeIssuesState;
	/** Present when `state` is `ok`. */
	readonly view: IPicodeProjectView | undefined;
}

/** How moving a Jira issue to another status ended. */
export type PicodeMoveOutcome = 'moved' | 'needsPermission' | 'notAllowed' | 'failed';

/** How saving a change to a Jira issue ended. */
export type PicodeEditOutcome = 'saved' | 'needsPermission' | 'rejected' | 'failed';

/** What an issue's type and priority can be changed to. Empty lists mean Jira did not say. */
export interface IPicodeJiraEditOptions {
	readonly types: readonly IPicodeNamed[];
	readonly priorities: readonly IPicodeNamed[];
}

/** What a GitHub issue's labels and assignee can be changed to. Empty lists mean GitHub did not say. */
export interface IPicodeGithubEditOptions {
	readonly labels: readonly string[];
	readonly assignees: readonly IPicodeNamed[];
}

export type PicodeConnectOutcome = 'connected' | 'cancelled' | 'denied' | 'expired' | 'failed' | 'notPro';

export interface IPicodeGithubAttempt {
	readonly code: IPicodeDeviceCode;
	readonly done: Promise<PicodeConnectOutcome>;
	cancel(): void;
}

/** Connecting GitHub and Jira, and reading their issues. The Account window's issue pages are built on this. */
export const IPicodeConnectorService = createDecorator<IPicodeConnectorService>('picodeConnectorService');

export interface IPicodeConnectorService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** False until the product ships the public identifiers of that service (it is then shown as coming soon). */
	isAvailable(service: PicodeConnectorService): boolean;
	isConnected(service: PicodeConnectorService): boolean;
	/** Where the PiCode app is installed on GitHub, when the product knows its address. */
	githubInstallUrl(): string | undefined;
	/** The Jira site the account is connected to. */
	readonly jiraSiteName: string | undefined;
	beginGithub(): Promise<IPicodeGithubAttempt>;
	/** `write` also asks for the permission to move issues between statuses and `boards` for reading the board's columns; what was granted before is kept. */
	connectAtlassian(token: CancellationToken, options?: { readonly write?: boolean; readonly boards?: boolean }): Promise<PicodeConnectOutcome>;
	/** Whether this Jira connection may move issues between statuses. */
	canMoveJiraIssues(): Promise<boolean>;
	/** Moves the issue to the column (or status) `target`. */
	moveJiraIssue(key: string, target: IPicodeBoardStatus): Promise<PicodeMoveOutcome>;
	loadJiraEditOptions(key: string): Promise<IPicodeJiraEditOptions>;
	/** Saves a change to one Jira issue (summary, type, priority, assignee, reporter or labels). */
	updateJiraIssue(key: string, patch: IPicodeJiraPatch): Promise<PicodeEditOutcome>;
	/** People of the site whose name matches `query`, to give the issue to them (`assignee`) or name them reporter. */
	searchJiraUsers(key: string, query: string, mode: 'assignee' | 'reporter'): Promise<readonly IPicodeNamed[] | 'needsPermission'>;
	/** Whether this Jira connection may look people up. */
	canSearchJiraUsers(): Promise<boolean>;
	loadGithubEditOptions(repo: string): Promise<IPicodeGithubEditOptions>;
	/** Saves a change to one GitHub issue (`owner/repo#12`): title, description, labels or assignee. */
	updateGithubIssue(key: string, patch: IPicodeGithubPatch): Promise<PicodeEditOutcome>;
	/** False when the server could not be told: the connection stands, and the screen must say so. */
	disconnect(service: PicodeConnectorService): Promise<boolean>;
	listIssues(source: PicodeIssueSource, scope?: IPicodeIssuesScope): Promise<IPicodeIssuesResult>;
	/** What `listIssues` last answered for this scope, without asking anyone. */
	knownIssues(source: PicodeIssueSource, scope?: IPicodeIssuesScope): IPicodeKnownIssues | undefined;
	/** The Jira spaces of the connected site (`id` is the key), to link the open folder to one. */
	listJiraProjects(): Promise<readonly IPicodeNamed[]>;
	/** The page of the connected Jira site where spaces are listed and created. */
	jiraProjectsUrl(): Promise<string | undefined>;
	/** The Jira space the open folder's current branch names (`ATW-52-…`), if any: only a hint. */
	workspaceJiraKeyHint(): Promise<string | undefined>;
	/** Every issue of one Jira project (`ATW`) or GitHub repository (`owner/repo`), open and closed, for the issues viewer. */
	loadProjectView(source: PicodeIssueSource, ref: string): Promise<IPicodeProjectViewResult>;
	/** `owner/repo` (lower case) of the open project when it is a GitHub repository. */
	workspaceRepoKey(): Promise<string | undefined>;
	/** What `workspaceRepoKey` last answered, without reading anything. */
	readonly knownWorkspaceRepoKey: string | undefined;
	/** Asks the cloud service which plan the account is on, and remembers the answer. */
	refreshPlan(): Promise<void>;
}

/** Where earlier versions kept tokens on this computer: wiped, they are no use to anyone now. */
const OLD_SECRET_KEY = (service: PicodeConnectorService) => `picode.connectors.${service}`;
const CONNECTED_KEY = (service: PicodeConnectorService) => `picode.connectors.${service}.connected`;
const JIRA_SITE_NAME_KEY = 'picode.connectors.atlassian.siteName';
/** What the editor remembers about a connection; it holds no secret. */
const CONNECTION_KEY = (service: PicodeConnectorService) => `picode.connectors.${service}.connection`;

const GITHUB_API = 'https://api.github.com';
const ATLASSIAN_API = 'https://api.atlassian.com';
/** Most repositories read in one go: each is a request, and the list is only a first look. */
const MAX_REPOS = 15;
/** The viewer reads up to this many pages of 100 issues; a bigger project is shown as its latest issues. */
const MAX_VIEW_PAGES = 3;
const ATLASSIAN_WAIT_MS = 5 * 60_000;
/** How long a list counts as just read: going back and forth between views does not ask for it again. */
const ISSUES_FRESH_MS = 60_000;

interface IHttpResult {
	readonly status: number;
	readonly json: unknown;
	readonly etag: string | undefined;
	readonly rateLimited: boolean;
}

/** The cloud service said this account is not Pro. */
class PicodeNotProError extends Error { }

function issuesCacheKey(source: PicodeIssueSource, scope: IPicodeIssuesScope): string {
	return `${source}|${scope.repo ?? ''}|${scope.project ?? ''}`;
}

class PicodeConnectorServiceImpl extends Disposable implements IPicodeConnectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** `If-None-Match` answers: a 304 does not count against GitHub's hourly limit. */
	private readonly etags = new Map<string, { readonly etag: string; readonly json: unknown }>();
	private readonly lastResults = new Map<string, readonly IPicodeIssue[]>();
	private readonly lastAnswers = new Map<string, { readonly result: IPicodeIssuesResult; readonly at: number }>();
	private lastWorkspaceRepoKey: string | undefined;

	constructor(
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService secretStorageService: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IURLService private readonly urlService: IURLService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		for (const service of ['github', 'atlassian'] as const) {
			void secretStorageService.delete(OLD_SECRET_KEY(service)).catch(() => undefined);
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, CONNECTED_KEY(service), this._store)(() => this._onDidChange.fire()));
		}
		// Another account must not see, even for a moment, the lists of the one before.
		this._register(this.authenticationService.onDidChangeSessions(({ providerId, event }) => {
			if (providerId === PICODE_AUTH_PROVIDER_ID && (event.added?.length || event.removed?.length)) {
				this.lastResults.clear();
				this.lastAnswers.clear();
			}
		}));
	}

	private get config() {
		return this.productService.picode?.connectors;
	}

	isAvailable(service: PicodeConnectorService): boolean {
		return service === 'github'
			? !!this.config?.github?.clientId
			: !!this.config?.atlassian?.clientId && !!this.config.atlassian.redirectUri;
	}

	githubInstallUrl(): string | undefined {
		const slug = this.config?.github?.appSlug;
		return slug && /^[a-z0-9][a-z0-9-]{0,38}$/.test(slug) ? `https://github.com/apps/${slug}/installations/new` : undefined;
	}

	isConnected(service: PicodeConnectorService): boolean {
		return this.storageService.getBoolean(CONNECTED_KEY(service), StorageScope.APPLICATION, false);
	}

	get jiraSiteName(): string | undefined {
		return this.storageService.get(JIRA_SITE_NAME_KEY, StorageScope.APPLICATION) || undefined;
	}

	// -- Connecting -------------------------------------------------------------------------------

	async beginGithub(): Promise<IPicodeGithubAttempt> {
		const clientId = this.config?.github?.clientId;
		if (!clientId) {
			throw new Error('GitHub is not available yet.');
		}
		// GitHub's login pages do not accept calls from the editor's window, so PiCode's cloud service asks them.
		const asked = await this.postCloud('/v1/connect/github', { action: 'start' });
		const code = asked?.status === 200 ? parseDeviceCode(asked.json) : undefined;
		if (!code) {
			throw new Error('GitHub did not give a code.');
		}
		const source = new CancellationTokenSource();
		const done = this.pollGithub(code, source.token).finally(() => source.dispose());
		return { code, done, cancel: () => source.cancel() };
	}

	private async pollGithub(code: IPicodeDeviceCode, token: CancellationToken): Promise<PicodeConnectOutcome> {
		const deadline = Date.now() + code.expiresInMs;
		let wait = code.intervalMs;
		while (Date.now() < deadline) {
			await timeout(wait, token).catch(() => undefined);
			if (token.isCancellationRequested) {
				return 'cancelled';
			}
			// A dropped connection while waiting is not the end: the next round asks again.
			const answer = await this.postCloud('/v1/connect/github', { action: 'poll', deviceCode: code.deviceCode });
			if (!answer || answer.status >= 500) {
				continue;
			}
			if (answer.status === 402) {
				return 'notPro';
			}
			const poll: PicodeDevicePoll = answer.status === 200 ? parseDevicePoll(answer.json) : { kind: 'failed' };
			switch (poll.kind) {
				case 'connected':
					this.save('github', {});
					void this.guideGithubInstallation();
					return 'connected';
				case 'slowDown': wait = poll.intervalMs ?? wait + 5000; break;
				case 'denied': return 'denied';
				case 'expired': return 'expired';
				case 'failed': return 'failed';
				case 'pending': break;
			}
		}
		return 'expired';
	}

	/**
	 * Connecting GitHub shows no issue until the PiCode app is installed on the person's
	 * repositories. So when it is not, its install page opens right away, and the issues appear (the
	 * panels are told) as soon as the installation exists.
	 */
	private async guideGithubInstallation(): Promise<void> {
		const url = this.githubInstallUrl();
		if (!url || (await this.installationCount()) !== 0) {
			return;
		}
		void this.openerService.open(URI.parse(url), { openExternal: true });
		// About five minutes, one look every six seconds; it stops if GitHub is disconnected meanwhile.
		for (let attempt = 0; attempt < 50; attempt++) {
			await timeout(6000);
			if (this._store.isDisposed || !this.isConnected('github')) {
				return;
			}
			if ((await this.installationCount()) > 0) {
				this._onDidChange.fire();
				return;
			}
		}
	}

	/** How many places the PiCode app is installed on for this person; -1 when GitHub could not say. */
	private async installationCount(): Promise<number> {
		try {
			const answer = await this.remote('GET', `${GITHUB_API}/user/installations?per_page=1`);
			const total = (answer.json as { total_count?: unknown } | undefined)?.total_count;
			return answer.status === 200 && typeof total === 'number' ? total : -1;
		} catch {
			return -1;
		}
	}

	async connectAtlassian(token: CancellationToken, options: { readonly write?: boolean; readonly boards?: boolean } = {}): Promise<PicodeConnectOutcome> {
		const clientId = this.config?.atlassian?.clientId;
		const redirectUri = this.config?.atlassian?.redirectUri;
		if (!clientId || !redirectUri) {
			return 'failed';
		}
		// Asking again must not take back what the account already allowed.
		const before = this.load('atlassian');
		const write = options.write === true || before?.canWrite === true;
		const boards = options.boards === true || before?.canReadBoards === true;
		const state = generateUuid();
		const code = await this.waitForAtlassianCode(atlassianAuthorizeUrl(clientId, redirectUri, state, { write, boards }), state, token);
		if (!code) {
			return token.isCancellationRequested ? 'cancelled' : 'expired';
		}
		const traded = await this.postCloud('/v1/connect/token', { service: 'atlassian', grant: 'authorization_code', code });
		if (traded?.status === 402) {
			return 'notPro';
		}
		if (traded?.status !== 200) {
			return 'failed';
		}
		const sites = await this.remote('GET', `${ATLASSIAN_API}/oauth/token/accessible-resources`).then(r => parseAtlassianSites(r.json), () => []);
		if (sites.length === 0) {
			return 'failed';
		}
		// The first site is used; an account with several can switch later (the name is shown on the page).
		this.save('atlassian', { site: sites[0], canWrite: write, canReadBoards: boards, canSearchUsers: write });
		return 'connected';
	}

	private waitForAtlassianCode(authorizeUrl: string, state: string, token: CancellationToken): Promise<string | undefined> {
		const scheme = this.productService.urlProtocol;
		const store = new DisposableStore();
		return new Promise<string | undefined>(resolve => {
			const finish = (code: string | undefined) => { store.dispose(); resolve(code); };
			// The handler listens before the browser opens, so the first callback cannot be missed.
			store.add(this.urlService.registerHandler({
				handleURL: async uri => {
					const code = connectorCodeFromCallback(uri, scheme, 'atlassian', state);
					if (!code) {
						return false;
					}
					finish(code);
					return true;
				},
			}));
			store.add(token.onCancellationRequested(() => finish(undefined)));
			const timer = setTimeout(() => finish(undefined), ATLASSIAN_WAIT_MS);
			store.add({ dispose: () => clearTimeout(timer) });
			this.openerService.open(URI.parse(authorizeUrl), { openExternal: true }).catch(() => finish(undefined));
		});
	}

	async disconnect(service: PicodeConnectorService): Promise<boolean> {
		// The credentials live on the server: disconnecting is removing them there, or it did not happen.
		const answer = await this.postCloud('/v1/connect/disconnect', { service });
		if (answer?.status !== 200) {
			return false;
		}
		this.forget(service);
		return true;
	}

	private forget(service: PicodeConnectorService): void {
		this.storageService.remove(CONNECTION_KEY(service), StorageScope.APPLICATION);
		this.storageService.remove(CONNECTED_KEY(service), StorageScope.APPLICATION);
		if (service === 'atlassian') {
			this.storageService.remove(JIRA_SITE_NAME_KEY, StorageScope.APPLICATION);
		}
		for (const cache of [this.lastResults, this.lastAnswers]) {
			for (const key of [...cache.keys()]) {
				if (key.startsWith(`${service === 'github' ? 'github' : 'jira'}|`)) {
					cache.delete(key);
				}
			}
		}
		this.etags.clear();
		this._onDidChange.fire();
	}

	// -- The connection ---------------------------------------------------------------------------

	private save(service: PicodeConnectorService, connection: IPicodeConnection): void {
		this.storageService.store(CONNECTION_KEY(service), JSON.stringify(connection), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(CONNECTED_KEY(service), true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (connection.site) {
			this.storageService.store(JIRA_SITE_NAME_KEY, connection.site.name, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this._onDidChange.fire();
	}

	private load(service: PicodeConnectorService): IPicodeConnection | undefined {
		if (!this.isConnected(service)) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(CONNECTION_KEY(service), StorageScope.APPLICATION) ?? 'null');
			return typeof parsed === 'object' && parsed !== null ? parsed as IPicodeConnection : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * One call to GitHub or Jira. It goes through PiCode's cloud service, which holds the connection
	 * and checks the plan every time: there is no other way to reach them from here. A connection
	 * that is gone comes back as a 401, as the service itself would answer.
	 */
	private async remote(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: { readonly json?: unknown; readonly ifNoneMatch?: string } = {}): Promise<IHttpResult> {
		const github = url.startsWith(GITHUB_API);
		const answer = await this.postCloud('/v1/connect/proxy', {
			service: github ? 'github' : 'atlassian',
			method,
			path: url.slice((github ? GITHUB_API : ATLASSIAN_API).length),
			...(options.json === undefined ? {} : { json: options.json }),
			...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
		});
		if (answer?.status === 402) {
			// The plan ended: the service already dropped the connections, and the screen follows.
			this.storageService.store(PICODE_PLAN_STORAGE_KEY, 'free', StorageScope.APPLICATION, StorageTarget.MACHINE);
			this.forget('github');
			this.forget('atlassian');
			throw new PicodeNotProError();
		}
		if (answer?.status !== 200 || typeof answer.json !== 'object' || answer.json === null) {
			throw new Error('The cloud service could not make the call.');
		}
		const inner = answer.json as { status?: unknown; json?: unknown; etag?: unknown; rateLimited?: unknown };
		return {
			status: typeof inner.status === 'number' ? inner.status : 0,
			json: inner.json,
			etag: typeof inner.etag === 'string' ? inner.etag : undefined,
			rateLimited: inner.rateLimited === true,
		};
	}

	async refreshPlan(): Promise<void> {
		const answer = await this.callCloud('GET', '/v1/account');
		const plan = answer?.status === 200 ? (answer.json as { plan?: unknown } | undefined)?.plan : undefined;
		// Anything else says nothing about the account: what is known stays as it is.
		if ((plan === 'pro' || plan === 'free') && plan !== this.storageService.get(PICODE_PLAN_STORAGE_KEY, StorageScope.APPLICATION)) {
			this.storageService.store(PICODE_PLAN_STORAGE_KEY, plan, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	/** One signed-in call to PiCode's cloud service. `undefined` = no session, no address or unreachable. */
	private postCloud(path: string, body: Record<string, unknown>): Promise<IHttpResult | undefined> {
		return this.callCloud('POST', path, body);
	}

	private async callCloud(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<IHttpResult | undefined> {
		const base = this.productService['configurationSync.store']?.url;
		const sessions = await this.authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }).catch(() => []);
		const session = sessions[0];
		if (!base || !session) {
			return undefined;
		}
		try {
			return await this.http(method, `${base.replace(/\/$/, '')}${path}`, {
				...(body === undefined ? {} : { json: body }),
				bearer: session.idToken ?? session.accessToken,
				headers: { 'X-Account-Type': PICODE_AUTH_PROVIDER_ID, 'X-Client-Name': 'picode', 'X-Client-Version': this.productService.version },
			});
		} catch (error) {
			this.logService.warn('[picode.connectors] the cloud service could not be reached', error);
			return undefined;
		}
	}

	// -- Reading issues ---------------------------------------------------------------------------

	knownIssues(source: PicodeIssueSource, scope: IPicodeIssuesScope = {}): IPicodeKnownIssues | undefined {
		const known = this.lastAnswers.get(issuesCacheKey(source, scope));
		return known && { result: known.result, fresh: known.result.state === 'ok' && Date.now() - known.at < ISSUES_FRESH_MS };
	}

	async listIssues(source: PicodeIssueSource, scope: IPicodeIssuesScope = {}): Promise<IPicodeIssuesResult> {
		const result = await this.readIssues(source, scope);
		if (result.state === 'notConnected') {
			this.lastAnswers.delete(issuesCacheKey(source, scope));
		} else {
			this.lastAnswers.set(issuesCacheKey(source, scope), { result, at: Date.now() });
		}
		return result;
	}

	private async readIssues(source: PicodeIssueSource, scope: IPicodeIssuesScope): Promise<IPicodeIssuesResult> {
		const cacheKey = issuesCacheKey(source, scope);
		const service: PicodeConnectorService = source === 'github' ? 'github' : 'atlassian';
		if (!this.isConnected(service)) {
			return { state: 'notConnected', issues: [], stale: false };
		}
		try {
			const outcome = await this.read(source, service, scope);
			if (typeof outcome !== 'string') {
				this.lastResults.set(cacheKey, outcome);
				return { state: 'ok', issues: outcome, stale: false };
			}
			return this.failure(cacheKey, outcome);
		} catch (error) {
			if (error instanceof PicodeNotProError) {
				return { state: 'notPro', issues: [], stale: false };
			}
			this.logService.warn('[picode.connectors] issues could not be read', error);
			return this.failure(cacheKey, 'offline');
		}
	}

	async loadProjectView(source: PicodeIssueSource, ref: string): Promise<IPicodeProjectViewResult> {
		const service: PicodeConnectorService = source === 'github' ? 'github' : 'atlassian';
		if (!this.isConnected(service)) {
			return { state: 'notConnected', view: undefined };
		}
		try {
			const outcome = await this.readView(source, service, ref);
			return typeof outcome === 'string' ? { state: outcome, view: undefined } : { state: 'ok', view: outcome };
		} catch (error) {
			if (error instanceof PicodeNotProError) {
				return { state: 'notPro', view: undefined };
			}
			this.logService.warn('[picode.connectors] the project could not be read', error);
			return { state: 'offline', view: undefined };
		}
	}

	private async readView(source: PicodeIssueSource, service: PicodeConnectorService, ref: string): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited'> {
		const connection = this.load(service);
		if (!connection) {
			return 'reconnect';
		}
		return source === 'github' ? this.readGithubView(ref) : this.readJiraView(connection, ref);
	}

	private async readJiraView(connection: IPicodeConnection, ref: string): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited'> {
		const site = connection.site;
		if (!site) {
			return 'reconnect';
		}
		if (!isJiraProjectKey(ref)) {
			throw new Error('That is not a Jira project.');
		}
		const api = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3`;
		const project = await this.getJson(`${api}/project/${ref}`);
		if (!project.ok) {
			return project.reason;
		}
		const statuses = await this.getJson(`${api}/project/${ref}/statuses`);
		if (!statuses.ok) {
			return statuses.reason;
		}
		const fields = 'summary,description,project,reporter,assignee,status,issuetype,priority,labels,created,updated';
		const jql = encodeURIComponent(`project = ${ref} ORDER BY updated DESC`);
		const issues: IPicodeBoardIssue[] = [];
		let pageToken: string | undefined;
		for (let page = 0; page < MAX_VIEW_PAGES; page++) {
			const more = pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : '';
			const read = await this.getJson(`${api}/search/jql?jql=${jql}&fields=${fields}&maxResults=100${more}`);
			if (!read.ok) {
				return read.reason;
			}
			issues.push(...mapJiraBoardIssues(read.json, site.url));
			pageToken = nextJiraPageToken(read.json);
			if (!pageToken) {
				break;
			}
		}
		const info = mapJiraProject(project.json);
		const board = await this.readJiraBoardColumns(connection, ref);
		return { source: 'jira', ref, name: info?.name ?? ref, layout: info?.layout ?? 'list', statuses: board.columns.length > 0 ? board.columns : mapJiraStatuses(statuses.json), issues, truncated: pageToken !== undefined, columns: board.columns.length > 0 ? 'board' : board.permission ? 'statuses' : 'needsPermission' };
	}

	/**
	 * The columns of the project's board, in Jira's order. Reading a board needs permissions the
	 * connection only has after the person allowed them (`permission` tells whether it does); when
	 * the board cannot be read, the caller says so instead of showing an order made up from statuses.
	 */
	private async readJiraBoardColumns(connection: IPicodeConnection, ref: string): Promise<{ readonly columns: IPicodeBoardStatus[]; readonly permission: boolean }> {
		const site = connection.site;
		const permission = connection.canReadBoards === true;
		if (!site || !permission) {
			return { columns: [], permission };
		}
		try {
			const agile = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/agile/1.0`;
			const boards = await this.remote('GET', `${agile}/board?projectKeyOrId=${ref}&maxResults=10`);
			const id = boards.status === 200 ? pickJiraBoardId(boards.json) : undefined;
			if (id === undefined) {
				return { columns: [], permission };
			}
			const config = await this.remote('GET', `${agile}/board/${id}/configuration`);
			return { columns: config.status === 200 ? mapJiraBoardColumns(config.json) : [], permission };
		} catch (error) {
			if (error instanceof PicodeNotProError) {
				throw error;
			}
			this.logService.warn('[picode.connectors] the board could not be read', error);
			return { columns: [], permission };
		}
	}

	private async readGithubView(ref: string): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited'> {
		const repo = parseGithubRepoRef(ref);
		if (!repo) {
			throw new Error('That is not a GitHub repository.');
		}
		const issues: IPicodeBoardIssue[] = [];
		let truncated = false;
		// One request after another, never several at once (GitHub asks for this).
		for (let page = 1; page <= MAX_VIEW_PAGES; page++) {
			const read = await this.getJson(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues?state=all&sort=updated&per_page=100&page=${page}`);
			if (!read.ok) {
				return read.reason;
			}
			issues.push(...mapGithubBoardIssues(read.json, repo));
			const received = Array.isArray(read.json) ? read.json.length : 0;
			if (received < 100) {
				break;
			}
			truncated = page === MAX_VIEW_PAGES;
		}
		return { source: 'github', ref, name: ref, layout: 'list', statuses: GITHUB_STATUSES, issues, truncated, columns: 'statuses' };
	}

	async canMoveJiraIssues(): Promise<boolean> {
		return this.load('atlassian')?.canWrite === true;
	}

	async moveJiraIssue(key: string, target: IPicodeBoardStatus): Promise<PicodeMoveOutcome> {
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
			return 'failed';
		}
		try {
			const outcome = await this.move(key, target);
			// Atlassian answers 401 when the token lacks the permission to change issues.
			return outcome === 'reconnect' ? 'needsPermission' : outcome;
		} catch (error) {
			this.logService.warn('[picode.connectors] the issue could not be moved', error);
			return 'failed';
		}
	}

	private async move(key: string, target: IPicodeBoardStatus): Promise<PicodeMoveOutcome | 'reconnect'> {
		const tokens = this.load('atlassian');
		if (!tokens?.site) {
			return 'reconnect';
		}
		if (!tokens.canWrite) {
			return 'needsPermission';
		}
		const url = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3/issue/${key}/transitions`;
		const options = await this.remote('GET', url);
		if (options.status === 401) {
			return 'reconnect';
		}
		if (options.status < 200 || options.status >= 300) {
			return options.status === 403 ? 'needsPermission' : 'failed';
		}
		const id = pickTransition(options.json, target);
		if (!id) {
			return 'notAllowed';
		}
		const done = await this.remote('POST', url, { json: { transition: { id } } });
		if (done.status >= 200 && done.status < 300) {
			return 'moved';
		}
		switch (done.status) {
			case 401: return 'reconnect';
			case 403: return 'needsPermission';
			// The move needs a field filled in (a resolution, say) that only Jira's own screen asks for.
			case 400: return 'notAllowed';
			default: return 'failed';
		}
	}

	async loadJiraEditOptions(key: string): Promise<IPicodeJiraEditOptions> {
		const none: IPicodeJiraEditOptions = { types: [], priorities: [] };
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
			return none;
		}
		try {
			const tokens = this.load('atlassian');
			if (!tokens?.site) {
				return none;
			}
			const api = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3`;
			const meta = await this.remote('GET', `${api}/issue/${key}/editmeta`);
			let types = meta.status === 200 ? mapEditMetaTypes(meta.json) : [];
			if (types.length === 0) {
				const project = await this.remote('GET', `${api}/project/${key.split('-')[0]}`);
				types = project.status === 200 ? mapProjectIssueTypes(project.json) : [];
			}
			// The priorities of the issue's own space; the site-wide list only when Jira does not say.
			let priorities = meta.status === 200 ? mapEditMetaPriorities(meta.json) : [];
			if (priorities.length === 0) {
				const all = await this.remote('GET', `${api}/priority`);
				priorities = all.status === 200 ? mapNamedList(all.json) : [];
			}
			return { types, priorities };
		} catch (error) {
			this.logService.warn('[picode.connectors] the options of an issue could not be read', error);
			return none;
		}
	}

	async updateJiraIssue(key: string, patch: IPicodeJiraPatch): Promise<PicodeEditOutcome> {
		const body = buildJiraUpdate(patch);
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !body) {
			return 'failed';
		}
		try {
			const outcome = await this.update(key, body);
			// Atlassian answers 401 when the token lacks the permission to change issues.
			return outcome === 'reconnect' ? 'needsPermission' : outcome;
		} catch (error) {
			this.logService.warn('[picode.connectors] the issue could not be saved', error);
			return 'failed';
		}
	}

	private async update(key: string, body: unknown): Promise<PicodeEditOutcome | 'reconnect'> {
		const tokens = this.load('atlassian');
		if (!tokens?.site) {
			return 'reconnect';
		}
		if (!tokens.canWrite) {
			return 'needsPermission';
		}
		const url = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3/issue/${key}`;
		const done = await this.remote('PUT', url, { json: body });
		if (done.status >= 200 && done.status < 300) {
			return 'saved';
		}
		switch (done.status) {
			case 401: return 'reconnect';
			// Jira's own rules: no right to edit the issue, a field the screen does not have, a value it does not allow.
			case 400:
			case 403: return 'rejected';
			default: return 'failed';
		}
	}

	async listJiraProjects(): Promise<readonly IPicodeNamed[]> {
		try {
			const tokens = this.load('atlassian');
			if (!tokens?.site) {
				return [];
			}
			const api = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3`;
			const found = await this.remote('GET', `${api}/project/search?maxResults=50&orderBy=name`);
			return found.status === 200 ? mapJiraProjectList(found.json) : [];
		} catch (error) {
			this.logService.warn('[picode.connectors] the spaces could not be listed', error);
			return [];
		}
	}

	async jiraProjectsUrl(): Promise<string | undefined> {
		const site = this.load('atlassian')?.site;
		return site ? `${site.url}/jira/projects` : undefined;
	}

	async workspaceJiraKeyHint(): Promise<string | undefined> {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		try {
			const head = await this.fileService.readFile(URI.joinPath(folder.uri, '.git', 'HEAD'));
			return jiraKeyFromBranch(head.value.toString());
		} catch {
			return undefined;
		}
	}

	async canSearchJiraUsers(): Promise<boolean> {
		return this.load('atlassian')?.canSearchUsers === true;
	}

	async searchJiraUsers(key: string, query: string, mode: 'assignee' | 'reporter'): Promise<readonly IPicodeNamed[] | 'needsPermission'> {
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || query.trim().length === 0) {
			return [];
		}
		try {
			const tokens = this.load('atlassian');
			if (!tokens?.site) {
				return [];
			}
			if (!tokens.canSearchUsers) {
				return 'needsPermission';
			}
			const api = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3`;
			const text = encodeURIComponent(query.trim());
			const url = mode === 'assignee'
				? `${api}/user/assignable/search?issueKey=${key}&query=${text}&maxResults=20`
				: `${api}/user/search?query=${text}&maxResults=20`;
			const found = await this.remote('GET', url);
			if (found.status === 401) {
				return 'needsPermission';
			}
			return found.status === 200 ? mapJiraUsers(found.json) : [];
		} catch (error) {
			this.logService.warn('[picode.connectors] people could not be searched', error);
			return [];
		}
	}

	async loadGithubEditOptions(repo: string): Promise<IPicodeGithubEditOptions> {
		const none: IPicodeGithubEditOptions = { labels: [], assignees: [] };
		if (!parseGithubRepoRef(repo)) {
			return none;
		}
		try {
			if (!this.isConnected('github')) {
				return none;
			}
			const [labels, assignees] = await Promise.all([
				this.remote('GET', `${GITHUB_API}/repos/${repo}/labels?per_page=100`),
				this.remote('GET', `${GITHUB_API}/repos/${repo}/assignees?per_page=100`),
			]);
			return {
				labels: labels.status === 200 ? mapGithubLabelNames(labels.json) : [],
				assignees: assignees.status === 200 ? mapGithubAssignees(assignees.json) : [],
			};
		} catch (error) {
			this.logService.warn('[picode.connectors] the options of a repository could not be read', error);
			return none;
		}
	}

	async updateGithubIssue(key: string, patch: IPicodeGithubPatch): Promise<PicodeEditOutcome> {
		const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(key);
		const body = buildGithubUpdate(patch);
		if (!match || !body) {
			return 'failed';
		}
		try {
			const outcome = await this.patchGithub(match[1], match[2], body);
			return outcome === 'reconnect' ? 'needsPermission' : outcome;
		} catch (error) {
			this.logService.warn('[picode.connectors] the issue could not be saved', error);
			return 'failed';
		}
	}

	private async patchGithub(repo: string, number: string, body: unknown): Promise<PicodeEditOutcome | 'reconnect'> {
		if (!this.isConnected('github')) {
			return 'reconnect';
		}
		const done = await this.remote('PATCH', `${GITHUB_API}/repos/${repo}/issues/${number}`, { json: body });
		if (done.status >= 200 && done.status < 300) {
			return 'saved';
		}
		if (done.rateLimited) {
			return 'failed';
		}
		switch (done.status) {
			case 401: return 'reconnect';
			// GitHub answers 403 when the App has not been allowed to write issues (or the person may not).
			case 403: return 'needsPermission';
			case 404:
			case 422: return 'rejected';
			default: return 'failed';
		}
	}

	/** A failed read still shows the last list, marked as old, instead of an empty page. */
	private failure(cacheKey: string, state: Exclude<PicodeIssuesState, 'ok' | 'notConnected'>): IPicodeIssuesResult {
		const last = this.lastResults.get(cacheKey);
		return { state, issues: last ?? [], stale: last !== undefined };
	}

	private async read(source: PicodeIssueSource, service: PicodeConnectorService, scope: IPicodeIssuesScope): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited' | 'notInstalled' | 'notVisible'> {
		const connection = this.load(service);
		if (!connection) {
			return 'reconnect';
		}
		return source === 'github' ? this.readGithub(scope.repo) : this.readJira(connection, scope.project);
	}

	private async readGithub(only?: string): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited' | 'notInstalled' | 'notVisible'> {
		const installations = await this.getJson(`${GITHUB_API}/user/installations?per_page=100`);
		if (!installations.ok) {
			return installations.reason;
		}
		const ids = (installations.json as { installations?: { id?: unknown }[] } | undefined)?.installations
			?.map(item => item.id).filter((id): id is number => typeof id === 'number') ?? [];
		if (ids.length === 0) {
			// An empty list here is not "no issues": the app sees no repository at all.
			return 'notInstalled';
		}
		const repos: IPicodeRepo[] = [];
		for (const id of ids) {
			const page = await this.getJson(`${GITHUB_API}/user/installations/${id}/repositories?per_page=100`);
			if (!page.ok) {
				return page.reason;
			}
			repos.push(...mapGithubRepos(page.json));
		}
		if (only) {
			const wanted = repos.filter(repo => `${repo.owner}/${repo.repo}`.toLowerCase() === only);
			if (wanted.length === 0) {
				return 'notVisible';
			}
			repos.splice(0, repos.length, ...wanted);
		}
		const here = await this.workspaceRepo();
		// The open project comes first: it is the one the person is most likely to fix.
		repos.sort((a, b) => Number(sameRepo(b, here)) - Number(sameRepo(a, here)));
		const issues: IPicodeIssue[] = [];
		// One request after another, never several at once (GitHub asks for this).
		for (const repo of repos.slice(0, MAX_REPOS)) {
			const list = await this.getJson(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues?state=open&sort=updated&per_page=30`);
			if (!list.ok) {
				return list.reason;
			}
			issues.push(...mapGithubIssues(list.json, repo));
		}
		return issues;
	}

	private async readJira(connection: IPicodeConnection, project?: string): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited'> {
		const site = connection.site;
		if (!site) {
			return 'reconnect';
		}
		const fields = 'summary,description,project,reporter,updated,labels';
		const jql = encodeURIComponent(project && isJiraProjectKey(project) ? `project = ${project} AND resolution = Unresolved ORDER BY updated DESC` : 'resolution = Unresolved ORDER BY updated DESC');
		const json = await this.getJson(`${ATLASSIAN_API}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=50`);
		return json.ok ? mapJiraIssues(json.json, site.url) : json.reason;
	}

	/** A GET that remembers the answer's ETag. Returns the JSON, or the reason it could not be read. */
	private async getJson(url: string): Promise<{ readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: 'reconnect' | 'rateLimited' }> {
		const known = this.etags.get(url);
		const answer = await this.remote('GET', url, known ? { ifNoneMatch: known.etag } : {});
		if (answer.status === 304 && known) {
			return { ok: true, json: known.json };
		}
		if (answer.status === 401) {
			return { ok: false, reason: 'reconnect' };
		}
		if (answer.rateLimited) {
			return { ok: false, reason: 'rateLimited' };
		}
		if (answer.status < 200 || answer.status >= 300) {
			throw new Error(`The service answered ${answer.status}.`);
		}
		if (answer.etag) {
			this.etags.set(url, { etag: answer.etag, json: answer.json });
		}
		return { ok: true, json: answer.json };
	}

	async workspaceRepoKey(): Promise<string | undefined> {
		const repo = await this.workspaceRepo();
		this.lastWorkspaceRepoKey = repo ? `${repo.owner}/${repo.repo}`.toLowerCase() : undefined;
		return this.lastWorkspaceRepoKey;
	}

	get knownWorkspaceRepoKey(): string | undefined {
		return this.lastWorkspaceRepoKey;
	}

	private async workspaceRepo(): Promise<IPicodeRepo | undefined> {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		try {
			const config = await this.fileService.readFile(URI.joinPath(folder.uri, '.git', 'config'));
			const origin = originFromGitConfig(config.value.toString());
			return origin ? parseGithubRemote(origin) : undefined;
		} catch {
			return undefined;
		}
	}

	// -- HTTP -------------------------------------------------------------------------------------

	private async http(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, options: {
		readonly bearer?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string;
		readonly form?: boolean;
		readonly json?: unknown;
	} = {}): Promise<IHttpResult> {
		const headers: Record<string, string> = { 'Accept': 'application/json', ...options.headers };
		if (options.bearer) {
			headers['Authorization'] = `Bearer ${options.bearer}`;
		}
		let data = options.body;
		if (options.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			data = JSON.stringify(options.json);
		} else if (options.form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
		}
		const context = await this.requestService.request({ type: method, url, headers, data, timeout: 20_000, callSite: 'picodeConnectors' }, CancellationToken.None);
		const status = context.res.statusCode ?? 0;
		const text = status === 304 ? null : await asText(context);
		let json: unknown;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		const header = (name: string): string | undefined => {
			const value = context.res.headers[name];
			return Array.isArray(value) ? value[0] : value;
		};
		return {
			status,
			json,
			etag: header('etag'),
			rateLimited: status === 429 || (status === 403 && header('x-ratelimit-remaining') === '0'),
		};
	}
}

function sameRepo(repo: IPicodeRepo, other: IPicodeRepo | undefined): boolean {
	return !!other && repo.owner.toLowerCase() === other.owner.toLowerCase() && repo.repo.toLowerCase() === other.repo.toLowerCase();
}

registerSingleton(IPicodeConnectorService, PicodeConnectorServiceImpl, InstantiationType.Delayed);
