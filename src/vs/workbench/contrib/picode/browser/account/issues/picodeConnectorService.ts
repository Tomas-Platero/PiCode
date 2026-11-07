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
import { PICODE_AUTH_PROVIDER_ID } from '../../picodeAccountProvider.js';
import {
	atlassianAuthorizeUrl, connectorCodeFromCallback, IPicodeConnectorTokens, IPicodeDeviceCode, needsRefresh,
	parseAtlassianSites, parseDeviceCode, parseDevicePoll, PicodeConnectorService, PicodeDevicePoll, tokensFromResponse,
} from './picodeConnectorAuth.js';
import {
	GITHUB_STATUSES, IPicodeBoardIssue, IPicodeProjectView, isJiraProjectKey, mapGithubBoardIssues, mapJiraBoardIssues, mapJiraProject,
	mapJiraStatuses, nextJiraPageToken, parseGithubRepoRef, pickTransition,
} from './picodeIssueBoard.js';
import { IPicodeIssue, IPicodeRepo, mapGithubIssues, mapGithubRepos, mapJiraIssues, originFromGitConfig, parseGithubRemote, PicodeIssueSource } from './picodeIssueSources.js';

/** How the last attempt to read issues ended. The page turns each into one plain sentence. */
export type PicodeIssuesState = 'ok' | 'notConnected' | 'reconnect' | 'offline' | 'rateLimited' | 'notPro';

export interface IPicodeIssuesResult {
	readonly state: PicodeIssuesState;
	readonly issues: readonly IPicodeIssue[];
	/** True when `issues` is the last list that was read, shown because the new read failed. */
	readonly stale: boolean;
}

export interface IPicodeProjectViewResult {
	readonly state: PicodeIssuesState;
	/** Present when `state` is `ok`. */
	readonly view: IPicodeProjectView | undefined;
}

/** How moving a Jira issue to another status ended. */
export type PicodeMoveOutcome = 'moved' | 'needsPermission' | 'notAllowed' | 'failed';

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
	/** The Jira site the account is connected to. */
	readonly jiraSiteName: string | undefined;
	beginGithub(): Promise<IPicodeGithubAttempt>;
	/** `write` also asks for the permission to move issues between statuses. */
	connectAtlassian(token: CancellationToken, write?: boolean): Promise<PicodeConnectOutcome>;
	/** Whether this Jira connection may move issues between statuses. */
	canMoveJiraIssues(): Promise<boolean>;
	moveJiraIssue(key: string, status: string): Promise<PicodeMoveOutcome>;
	disconnect(service: PicodeConnectorService): Promise<void>;
	listIssues(source: PicodeIssueSource): Promise<IPicodeIssuesResult>;
	/** Every issue of one Jira project (`ATW`) or GitHub repository (`owner/repo`), open and closed, for the issues viewer. */
	loadProjectView(source: PicodeIssueSource, ref: string): Promise<IPicodeProjectViewResult>;
	/** `owner/repo` (lower case) of the open project when it is a GitHub repository. */
	workspaceRepoKey(): Promise<string | undefined>;
}

const SECRET_KEY = (service: PicodeConnectorService) => `picode.connectors.${service}`;
const CONNECTED_KEY = (service: PicodeConnectorService) => `picode.connectors.${service}.connected`;
const JIRA_SITE_NAME_KEY = 'picode.connectors.atlassian.siteName';

const GITHUB_API = 'https://api.github.com';
const ATLASSIAN_API = 'https://api.atlassian.com';
/** Most repositories read in one go: each is a request, and the list is only a first look. */
const MAX_REPOS = 15;
/** The viewer reads up to this many pages of 100 issues; a bigger project is shown as its latest issues. */
const MAX_VIEW_PAGES = 3;
const ATLASSIAN_WAIT_MS = 5 * 60_000;

interface IHttpResult {
	readonly status: number;
	readonly json: unknown;
	readonly etag: string | undefined;
	readonly rateLimited: boolean;
}

class PicodeConnectorServiceImpl extends Disposable implements IPicodeConnectorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** One renewal at a time per service: Atlassian's refresh token changes with every use, so two at once would kill it. */
	private readonly refreshing = new Map<PicodeConnectorService, Promise<IPicodeConnectorTokens | undefined>>();
	/** `If-None-Match` answers: a 304 does not count against GitHub's hourly limit. */
	private readonly etags = new Map<string, { readonly etag: string; readonly json: unknown }>();
	private readonly lastResults = new Map<PicodeIssueSource, readonly IPicodeIssue[]>();

	constructor(
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
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
			this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, CONNECTED_KEY(service), this._store)(() => this._onDidChange.fire()));
		}
	}

	private get config() {
		return this.productService.picode?.connectors;
	}

	isAvailable(service: PicodeConnectorService): boolean {
		return service === 'github'
			? !!this.config?.github?.clientId
			: !!this.config?.atlassian?.clientId && !!this.config.atlassian.redirectUri;
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
			const poll: PicodeDevicePoll = answer.status === 200 ? parseDevicePoll(answer.json, Date.now()) : { kind: 'failed' };
			switch (poll.kind) {
				case 'tokens':
					await this.save('github', poll.tokens);
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

	async connectAtlassian(token: CancellationToken, write = false): Promise<PicodeConnectOutcome> {
		const clientId = this.config?.atlassian?.clientId;
		const redirectUri = this.config?.atlassian?.redirectUri;
		if (!clientId || !redirectUri) {
			return 'failed';
		}
		const state = generateUuid();
		const code = await this.waitForAtlassianCode(atlassianAuthorizeUrl(clientId, redirectUri, state, write), state, token);
		if (!code) {
			return token.isCancellationRequested ? 'cancelled' : 'expired';
		}
		const traded = await this.askCloud({ service: 'atlassian', grant: 'authorization_code', code });
		if (traded === 'notPro' || traded === undefined) {
			return traded === 'notPro' ? 'notPro' : 'failed';
		}
		const sites = await this.http('GET', `${ATLASSIAN_API}/oauth/token/accessible-resources`, { bearer: traded.accessToken }).then(r => parseAtlassianSites(r.json), () => []);
		if (sites.length === 0) {
			return 'failed';
		}
		// The first site is used; an account with several can switch later (the name is shown on the page).
		await this.save('atlassian', { ...traded, site: sites[0], canWrite: write });
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

	async disconnect(service: PicodeConnectorService): Promise<void> {
		await this.secretStorageService.delete(SECRET_KEY(service));
		this.storageService.remove(CONNECTED_KEY(service), StorageScope.APPLICATION);
		if (service === 'atlassian') {
			this.storageService.remove(JIRA_SITE_NAME_KEY, StorageScope.APPLICATION);
		}
		this.lastResults.delete(service === 'github' ? 'github' : 'jira');
		this.etags.clear();
		this._onDidChange.fire();
	}

	// -- Tokens -----------------------------------------------------------------------------------

	private async save(service: PicodeConnectorService, tokens: IPicodeConnectorTokens): Promise<void> {
		await this.secretStorageService.set(SECRET_KEY(service), JSON.stringify(tokens));
		this.storageService.store(CONNECTED_KEY(service), true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (tokens.site) {
			this.storageService.store(JIRA_SITE_NAME_KEY, tokens.site.name, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		this._onDidChange.fire();
	}

	private async load(service: PicodeConnectorService): Promise<IPicodeConnectorTokens | undefined> {
		try {
			const raw = await this.secretStorageService.get(SECRET_KEY(service));
			const parsed = raw ? JSON.parse(raw) as Partial<IPicodeConnectorTokens> : undefined;
			return parsed && typeof parsed.accessToken === 'string' && parsed.accessToken ? parsed as IPicodeConnectorTokens : undefined;
		} catch {
			return undefined;
		}
	}

	/** A token that is good for the next request, renewed through the cloud service when it is about to die. */
	private async validTokens(service: PicodeConnectorService, forceRefresh = false): Promise<IPicodeConnectorTokens | 'notPro' | undefined> {
		const tokens = await this.load(service);
		if (!tokens || (!forceRefresh && !needsRefresh(tokens, Date.now()))) {
			return tokens;
		}
		if (!tokens.refreshToken) {
			return forceRefresh ? undefined : tokens;
		}
		let pending = this.refreshing.get(service);
		if (!pending) {
			pending = this.askCloud({ service, grant: 'refresh_token', refreshToken: tokens.refreshToken })
				.then(async renewed => {
					if (renewed === 'notPro' || renewed === undefined) {
						return undefined;
					}
					const next = { ...renewed, site: tokens.site, canWrite: tokens.canWrite };
					await this.save(service, next);
					return next;
				})
				.finally(() => this.refreshing.delete(service));
			this.refreshing.set(service, pending);
		}
		const renewed = await pending;
		return renewed ?? undefined;
	}

	/** Asks PiCode's cloud service to trade or renew a token (it holds the secret). `undefined` = refused or unreachable. */
	private async askCloud(body: Record<string, string>): Promise<IPicodeConnectorTokens | 'notPro' | undefined> {
		const answer = await this.postCloud('/v1/connect/token', body);
		if (answer?.status === 402) {
			return 'notPro';
		}
		const data = typeof answer?.json === 'object' && answer.json !== null ? answer.json as Record<string, unknown> : undefined;
		const tokens = data ? tokensFromResponse(data, Date.now()) : undefined;
		return answer?.status === 200 && tokens?.accessToken ? tokens : undefined;
	}

	/** One signed-in call to PiCode's cloud service. `undefined` = no session, no address or unreachable. */
	private async postCloud(path: string, body: Record<string, string>): Promise<IHttpResult | undefined> {
		const base = this.productService['configurationSync.store']?.url;
		const sessions = await this.authenticationService.getSessions(PICODE_AUTH_PROVIDER_ID, [], { activateImmediate: true }).catch(() => []);
		const session = sessions[0];
		if (!base || !session) {
			return undefined;
		}
		try {
			return await this.http('POST', `${base.replace(/\/$/, '')}${path}`, {
				json: body,
				bearer: session.idToken ?? session.accessToken,
				headers: { 'X-Account-Type': PICODE_AUTH_PROVIDER_ID, 'X-Client-Name': 'picode', 'X-Client-Version': this.productService.version },
			});
		} catch (error) {
			this.logService.warn('[picode.connectors] the cloud service could not be reached', error);
			return undefined;
		}
	}

	// -- Reading issues ---------------------------------------------------------------------------

	async listIssues(source: PicodeIssueSource): Promise<IPicodeIssuesResult> {
		const service: PicodeConnectorService = source === 'github' ? 'github' : 'atlassian';
		if (!this.isConnected(service)) {
			return { state: 'notConnected', issues: [], stale: false };
		}
		try {
			let outcome = await this.read(source, service, false);
			if (outcome === 'reconnect') {
				// One renewal and one more try; a second refusal means the person must connect again.
				outcome = await this.read(source, service, true);
			}
			if (typeof outcome !== 'string') {
				this.lastResults.set(source, outcome);
				return { state: 'ok', issues: outcome, stale: false };
			}
			return this.failure(source, outcome);
		} catch (error) {
			this.logService.warn('[picode.connectors] issues could not be read', error);
			return this.failure(source, 'offline');
		}
	}

	async loadProjectView(source: PicodeIssueSource, ref: string): Promise<IPicodeProjectViewResult> {
		const service: PicodeConnectorService = source === 'github' ? 'github' : 'atlassian';
		if (!this.isConnected(service)) {
			return { state: 'notConnected', view: undefined };
		}
		try {
			let outcome = await this.readView(source, service, ref, false);
			if (outcome === 'reconnect') {
				outcome = await this.readView(source, service, ref, true);
			}
			return typeof outcome === 'string' ? { state: outcome, view: undefined } : { state: 'ok', view: outcome };
		} catch (error) {
			this.logService.warn('[picode.connectors] the project could not be read', error);
			return { state: 'offline', view: undefined };
		}
	}

	private async readView(source: PicodeIssueSource, service: PicodeConnectorService, ref: string, forceRefresh: boolean): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited' | 'notPro'> {
		const tokens = await this.validTokens(service, forceRefresh);
		if (tokens === 'notPro') {
			return 'notPro';
		}
		if (!tokens) {
			return 'reconnect';
		}
		return source === 'github' ? this.readGithubView(tokens.accessToken, ref) : this.readJiraView(tokens, ref);
	}

	private async readJiraView(tokens: IPicodeConnectorTokens, ref: string): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited'> {
		const site = tokens.site;
		if (!site) {
			return 'reconnect';
		}
		if (!isJiraProjectKey(ref)) {
			throw new Error('That is not a Jira project.');
		}
		const api = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3`;
		const project = await this.getJson(`${api}/project/${ref}`, tokens.accessToken);
		if (!project.ok) {
			return project.reason;
		}
		const statuses = await this.getJson(`${api}/project/${ref}/statuses`, tokens.accessToken);
		if (!statuses.ok) {
			return statuses.reason;
		}
		const fields = 'summary,description,project,reporter,assignee,status,issuetype,priority,labels,created,updated';
		const jql = encodeURIComponent(`project = ${ref} ORDER BY updated DESC`);
		const issues: IPicodeBoardIssue[] = [];
		let pageToken: string | undefined;
		for (let page = 0; page < MAX_VIEW_PAGES; page++) {
			const more = pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : '';
			const read = await this.getJson(`${api}/search/jql?jql=${jql}&fields=${fields}&maxResults=100${more}`, tokens.accessToken);
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
		return { source: 'jira', ref, name: info?.name ?? ref, layout: info?.layout ?? 'list', statuses: mapJiraStatuses(statuses.json), issues, truncated: pageToken !== undefined };
	}

	private async readGithubView(accessToken: string, ref: string): Promise<IPicodeProjectView | 'reconnect' | 'rateLimited'> {
		const repo = parseGithubRepoRef(ref);
		if (!repo) {
			throw new Error('That is not a GitHub repository.');
		}
		const issues: IPicodeBoardIssue[] = [];
		let truncated = false;
		// One request after another, never several at once (GitHub asks for this).
		for (let page = 1; page <= MAX_VIEW_PAGES; page++) {
			const read = await this.getJson(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues?state=all&sort=updated&per_page=100&page=${page}`, accessToken);
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
		return { source: 'github', ref, name: ref, layout: 'list', statuses: GITHUB_STATUSES, issues, truncated };
	}

	async canMoveJiraIssues(): Promise<boolean> {
		return (await this.load('atlassian'))?.canWrite === true;
	}

	async moveJiraIssue(key: string, status: string): Promise<PicodeMoveOutcome> {
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
			return 'failed';
		}
		try {
			let outcome = await this.move(key, status, false);
			if (outcome === 'reconnect') {
				outcome = await this.move(key, status, true);
			}
			// Atlassian answers 401 when the token lacks the permission to change issues.
			return outcome === 'reconnect' ? 'needsPermission' : outcome;
		} catch (error) {
			this.logService.warn('[picode.connectors] the issue could not be moved', error);
			return 'failed';
		}
	}

	private async move(key: string, status: string, forceRefresh: boolean): Promise<PicodeMoveOutcome | 'reconnect'> {
		const tokens = await this.validTokens('atlassian', forceRefresh);
		if (tokens === 'notPro') {
			return 'failed';
		}
		if (!tokens?.site) {
			return 'reconnect';
		}
		if (!tokens.canWrite) {
			return 'needsPermission';
		}
		const url = `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(tokens.site.cloudId)}/rest/api/3/issue/${key}/transitions`;
		const options = await this.http('GET', url, { bearer: tokens.accessToken });
		if (options.status === 401) {
			return 'reconnect';
		}
		if (options.status < 200 || options.status >= 300) {
			return options.status === 403 ? 'needsPermission' : 'failed';
		}
		const id = pickTransition(options.json, status);
		if (!id) {
			return 'notAllowed';
		}
		const done = await this.http('POST', url, { bearer: tokens.accessToken, json: { transition: { id } } });
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

	/** A failed read still shows the last list, marked as old, instead of an empty page. */
	private failure(source: PicodeIssueSource, state: Exclude<PicodeIssuesState, 'ok' | 'notConnected'>): IPicodeIssuesResult {
		const last = this.lastResults.get(source);
		return { state, issues: last ?? [], stale: last !== undefined };
	}

	private async read(source: PicodeIssueSource, service: PicodeConnectorService, forceRefresh: boolean): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited' | 'notPro'> {
		const tokens = await this.validTokens(service, forceRefresh);
		if (tokens === 'notPro') {
			return 'notPro';
		}
		if (!tokens) {
			return 'reconnect';
		}
		return source === 'github' ? this.readGithub(tokens.accessToken) : this.readJira(tokens);
	}

	private async readGithub(accessToken: string): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited'> {
		const installations = await this.getJson(`${GITHUB_API}/user/installations?per_page=100`, accessToken);
		if (!installations.ok) {
			return installations.reason;
		}
		const ids = (installations.json as { installations?: { id?: unknown }[] } | undefined)?.installations
			?.map(item => item.id).filter((id): id is number => typeof id === 'number') ?? [];
		const repos: IPicodeRepo[] = [];
		for (const id of ids) {
			const page = await this.getJson(`${GITHUB_API}/user/installations/${id}/repositories?per_page=100`, accessToken);
			if (!page.ok) {
				return page.reason;
			}
			repos.push(...mapGithubRepos(page.json));
		}
		const here = await this.workspaceRepo();
		// The open project comes first: it is the one the person is most likely to fix.
		repos.sort((a, b) => Number(sameRepo(b, here)) - Number(sameRepo(a, here)));
		const issues: IPicodeIssue[] = [];
		// One request after another, never several at once (GitHub asks for this).
		for (const repo of repos.slice(0, MAX_REPOS)) {
			const list = await this.getJson(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues?state=open&sort=updated&per_page=30`, accessToken);
			if (!list.ok) {
				return list.reason;
			}
			issues.push(...mapGithubIssues(list.json, repo));
		}
		return issues;
	}

	private async readJira(tokens: IPicodeConnectorTokens): Promise<readonly IPicodeIssue[] | 'reconnect' | 'rateLimited'> {
		const site = tokens.site;
		if (!site) {
			return 'reconnect';
		}
		const fields = 'summary,description,project,reporter,updated,labels';
		const jql = encodeURIComponent('resolution = Unresolved ORDER BY updated DESC');
		const json = await this.getJson(`${ATLASSIAN_API}/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=50`, tokens.accessToken);
		return json.ok ? mapJiraIssues(json.json, site.url) : json.reason;
	}

	/** A GET that remembers the answer's ETag. Returns the JSON, or the reason it could not be read. */
	private async getJson(url: string, bearer: string): Promise<{ readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: 'reconnect' | 'rateLimited' }> {
		const known = this.etags.get(url);
		const answer = await this.http('GET', url, { bearer, headers: known ? { 'If-None-Match': known.etag } : undefined });
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
		return repo ? `${repo.owner}/${repo.repo}`.toLowerCase() : undefined;
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

	private async http(method: 'GET' | 'POST', url: string, options: {
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
		if (url.startsWith(GITHUB_API)) {
			headers['Accept'] = 'application/vnd.github+json';
			headers['X-GitHub-Api-Version'] = '2022-11-28';
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
