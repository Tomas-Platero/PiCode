/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { ISessionDataService } from '../common/sessionDataService.js';
import { SessionServerToolName } from '../common/serverToolNames.js';
import { ActionType } from '../common/state/sessionActions.js';
import { buildDefaultChatUri, isAhpChatChannel, isDefaultChatUri, type Turn, type URI as ProtocolURI } from '../common/state/sessionState.js';
import { buildConversationContext, renderResponseMarkdown, truncateMiddle } from '../common/agentHostConversationContext.js';
import { AgentHostStateManager } from './agentHostStateManager.js';
import type { IAgentHostOctoKitService } from './shared/agentHostOctoKitService.js';
import { AGENT_HOST_TITLE_SOURCE_AGENT, AGENT_HOST_TITLE_SOURCE_AUTO, AGENT_HOST_TITLE_SOURCE_USER, customChatTitleMetadataKey, customChatTitleSourceMetadataKey, persistSessionMetadata, SESSION_CUSTOM_TITLE_KEY, SESSION_CUSTOM_TITLE_SOURCE_KEY } from './shared/persistSessionMetadata.js';

const MAX_TITLE_LENGTH = 200;
const MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH = 40;
const CHAT_RENAME_REMINDER = 'Reminder: This chat currently has an auto-generated or placeholder title. If the user references an issue or PR, fetch it first. Please give the chat a short, descriptive title based on the user\'s intent by calling `rename_chat` with `automatic: true`, silently and without a preamble. The user must not know that you are renaming. Do not skip it.';

/**
 * Soft upper bound, in characters, for the whole context fed to the utility
 * model when titling a session, including any appended GitHub context. Sized
 * to stay well within the small model's context window while leaving room for
 * the prompt scaffolding.
 */
const MAX_TITLE_CONTEXT_CHARS = 20000;

/** Everything the utility model is told about when asked for a title. */
interface ITitlePromptContext {
	/** The request or conversation to title. */
	readonly content: string;
	/** Whether {@link content} is a whole conversation rather than a single request. */
	readonly isConversation: boolean;
	/** Text scanned for GitHub links to enrich {@link content} with, or `undefined` to skip enrichment. */
	readonly gitHubReferenceSource?: string;
	/** The title in place already, offered to the model as the incumbent. */
	readonly currentTitle?: string;
}

export interface IAgentHostSessionTitleControllerOptions {
	readonly sessionDataService: ISessionDataService;
	readonly getGitHubCopilotToken?: () => string | undefined;
	readonly getGitHubToken?: () => string | undefined;
	readonly getGitHubHost?: () => string | undefined;
	readonly gitHubContextRequestTimeout?: number;
	readonly octoKitService?: IAgentHostOctoKitService;
	readonly isActiveAgentTitleGenerationEnabled?: () => boolean;
}

export class AgentHostSessionTitleController extends Disposable {

	private readonly _titleGenerationCancellationSources = new Map<ProtocolURI, CancellationTokenSource>();

	/**
	 * The most recent title this controller applied for a given session/chat
	 * key. Used to detect whether the title was changed (e.g. a manual
	 * `/rename` or user edit) since we last set it, so we never clobber a
	 * deliberate title with an auto-generated one.
	 */
	private readonly _lastAppliedTitle = new Map<ProtocolURI, string>();

	/**
	 * Session/chat keys whose current title is a provisional placeholder set by
	 * {@link seedProvisionalTitle} (e.g. from a `!command`). Such a title does
	 * not describe the session's topic, so the first subsequent request that
	 * carries real intent replaces it with a generated title via
	 * {@link seedTitleFromFirstMessage}.
	 */
	private readonly _provisionalTitles = new Set<ProtocolURI>();
	private readonly _autoTitles = new Set<ProtocolURI>();
	private readonly _renamedTitles = new Set<ProtocolURI>();

	constructor(
		private readonly _stateManager: AgentHostStateManager,
		private readonly _options: IAgentHostSessionTitleControllerOptions,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	seedTitleFromFirstMessage(channel: ProtocolURI, userPrompt: string, chatChannel?: ProtocolURI): void {
		if (this._isEphemeralSession(channel)) {
			return;
		}
		const activeAgentTitleGenerationEnabled = this._isActiveAgentTitleGenerationEnabled(channel);
		const fallbackTitle = activeAgentTitleGenerationEnabled
			? this._normalizeActiveAgentFallbackTitle(userPrompt)
			: this._normalizeTitle(userPrompt);
		if (!fallbackTitle) {
			return;
		}

		const independentChat = this._independentChatChannel(channel, chatChannel);
		const key = independentChat ?? channel;
		const state = independentChat ? this._stateManager.getChatState(independentChat) : this._stateManager.getSessionState(channel);
		if (!state || !this._canSeedFirstMessageTitle(key, state.turns.length, state.title)) {
			return;
		}
		const replacesProvisionalTitle = this._provisionalTitles.has(key);
		this._provisionalTitles.delete(key);
		this._applySeedTitle(channel, independentChat, fallbackTitle);
		if (activeAgentTitleGenerationEnabled) {
			this.markTitleAuto(channel, independentChat, fallbackTitle);
			return;
		}
		if (replacesProvisionalTitle) {
			this._persistAutoTitle(channel, independentChat, fallbackTitle);
		}
		this._generateTitleSoon(
			key,
			{ content: userPrompt, isConversation: false, gitHubReferenceSource: userPrompt },
			fallbackTitle,
			title => this._applySeedTitle(channel, independentChat, title),
			() => this._currentSeedTitle(channel, independentChat) === this._lastAppliedTitle.get(key),
			title => this._persistAutoTitle(channel, independentChat, title),
		);
	}

	/** Seeds and persists a provisional title suggested by a locally handled command. */
	seedProvisionalTitle(channel: ProtocolURI, suggestedTitle: string, chatChannel?: ProtocolURI): void {
		if (this._isEphemeralSession(channel)) {
			return;
		}
		const title = this._normalizeTitle(suggestedTitle, this._isActiveAgentTitleGenerationEnabled(channel) ? MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH : MAX_TITLE_LENGTH);
		if (!title) {
			return;
		}

		const independentChat = this._independentChatChannel(channel, chatChannel);
		const key = independentChat ?? channel;
		const state = independentChat ? this._stateManager.getChatState(independentChat) : this._stateManager.getSessionState(channel);
		if (!state || !this._canSeedProvisionalTitle(key, state.title)) {
			return;
		}
		this._provisionalTitles.add(key);
		this._applySeedTitle(channel, independentChat, title);
		this._persistAutoTitle(channel, independentChat, title);
	}

	/** Trims, collapses whitespace, and length-caps a candidate title. */
	private _normalizeTitle(text: string, maxLength = MAX_TITLE_LENGTH): string {
		return Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, maxLength).join('').trim();
	}

	private _normalizeActiveAgentFallbackTitle(text: string): string {
		const normalized = text.trim().replace(/\s+/g, ' ');
		const characters = Array.from(normalized);
		if (characters.length <= MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH) {
			return normalized;
		}
		const limited = characters.slice(0, MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH).join('');
		if (!limited.includes(' ')) {
			return `${Array.from(limited).slice(0, MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH - 3).join('')}...`;
		}
		const remaining = characters.slice(MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH).join('');
		const nextWordBoundary = remaining.indexOf(' ');
		const completedWord = nextWordBoundary >= 0 ? remaining.slice(0, nextWordBoundary) : remaining;
		if (Array.from(completedWord).length > MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH) {
			return `${Array.from(limited).slice(0, MAX_ACTIVE_AGENT_FALLBACK_TITLE_LENGTH - 3).join('')}...`;
		}
		return nextWordBoundary >= 0
			? `${limited}${completedWord}...`
			: normalized;
	}

	/**
	 * The independently titled chat a seed should target, or `undefined` to
	 * title the session-backed sole default chat.
	 */
	private _independentChatChannel(channel: ProtocolURI, chatChannel?: ProtocolURI): ProtocolURI | undefined {
		if (!chatChannel || !isAhpChatChannel(chatChannel)) {
			return undefined;
		}
		return !isDefaultChatUri(chatChannel) || (this._stateManager.getSessionState(channel)?.chats.length ?? 1) > 1
			? chatChannel
			: undefined;
	}

	/**
	 * Applies `title` to the independently titled chat (`independentChat`) or, when
	 * that is `undefined`, to the session itself, recording it as last-applied.
	 */
	private _applySeedTitle(channel: ProtocolURI, independentChat: ProtocolURI | undefined, title: string): void {
		if (independentChat) {
			this._applyTitle(independentChat, title, t => this._stateManager.updateChatTitle(channel, independentChat, t));
			this._persistAutoTitleSource(channel, independentChat);
		} else {
			this._applyTitle(channel, title, t => this._stateManager.dispatchServerAction(channel, {
				type: ActionType.SessionTitleChanged,
				title: t,
			}));
			this._persistAutoTitleSource(channel, undefined);
		}
	}

	/** Persists `title` as the custom title of the addressed independent chat or session. */
	private _persistAutoTitle(channel: ProtocolURI, independentChat: ProtocolURI | undefined, title: string): void {
		if (independentChat) {
			this._persistSessionFlag(channel, customChatTitleMetadataKey(independentChat), title);
			this._persistSessionFlag(channel, customChatTitleSourceMetadataKey(independentChat), AGENT_HOST_TITLE_SOURCE_AUTO);
			return;
		}
		this._persistSessionFlag(channel, SESSION_CUSTOM_TITLE_KEY, title);
		this._persistSessionFlag(channel, SESSION_CUSTOM_TITLE_SOURCE_KEY, AGENT_HOST_TITLE_SOURCE_AUTO);
	}

	private _persistAutoTitleSource(channel: ProtocolURI, independentChat: ProtocolURI | undefined): void {
		this._persistSessionFlag(channel, independentChat ? customChatTitleSourceMetadataKey(independentChat) : SESSION_CUSTOM_TITLE_SOURCE_KEY, AGENT_HOST_TITLE_SOURCE_AUTO);
	}

	/** The live title of the addressed independent chat or session. */
	private _currentSeedTitle(channel: ProtocolURI, independentChat: ProtocolURI | undefined): string | undefined {
		return independentChat ? this._stateManager.getChatState(independentChat)?.title : this._stateManager.getSessionState(channel)?.title;
	}

	/**
	 * Whether {@link seedTitleFromFirstMessage} may (re)title `key`: true for a
	 * fresh, untitled target (its first message) or when its title is a
	 * provisional placeholder we applied and no one has changed it since — the
	 * first real request supersedes the placeholder.
	 */
	private _canSeedFirstMessageTitle(key: ProtocolURI, turnsLength: number, currentTitle: string | undefined): boolean {
		if (turnsLength === 0 && !currentTitle) {
			return true;
		}
		return this._provisionalTitles.has(key) && !!currentTitle && currentTitle === this._lastAppliedTitle.get(key);
	}

	/**
	 * Whether {@link seedProvisionalTitle} may (re)title `key`: true when it is
	 * untitled (the first message carried a suggestion) or when its title is a
	 * provisional placeholder we applied and no one has changed it since —
	 * successive suggestions keep the newest one visible without clobbering a
	 * manual rename.
	 */
	private _canSeedProvisionalTitle(key: ProtocolURI, currentTitle: string | undefined): boolean {
		if (!currentTitle) {
			return true;
		}
		return this._provisionalTitles.has(key) && currentTitle === this._lastAppliedTitle.get(key);
	}

	/**
	 * Re-generates the title once the first turn has completed, this time
	 * using the full first-turn context (the user request plus the agent's
	 * textual response) rather than just the opening message. This only runs
	 * for the very first turn and only when the current title is still the one
	 * this controller last applied — a manual `/rename`, a user edit, or a
	 * forked session's inherited title all suppress it.
	 *
	 * Only normal text response parts are considered (tool calls, reasoning,
	 * and other parts are ignored). If the context still exceeds the budget
	 * the middle is removed (marked with `...`). The user's first request is
	 * always preserved.
	 */
	refineTitleFromFirstTurn(channel: ProtocolURI, chatChannel?: ProtocolURI): void {
		if (this._isEphemeralSession(channel)) {
			return;
		}
		if (this._isActiveAgentTitleGenerationEnabled(channel)) {
			return;
		}
		const isAdditionalChat = !!chatChannel && isAhpChatChannel(chatChannel) && !isDefaultChatUri(chatChannel);
		if (isAdditionalChat) {
			const chatState = this._stateManager.getChatState(chatChannel);
			if (!chatState || chatState.turns.length !== 1) {
				return;
			}
			const lastApplied = this._lastAppliedTitle.get(chatChannel);
			if (lastApplied === undefined || chatState.title !== lastApplied) {
				return;
			}
			const turn = chatState.turns[0];
			const context = this._buildFirstTurnContext(turn);
			if (!context) {
				return;
			}
			const apply = (title: string) => {
				this._applyTitle(chatChannel, title, t => this._stateManager.updateChatTitle(channel, chatChannel, t));
				this._persistAutoTitleSource(channel, chatChannel);
			};
			this._generateTitleSoon(
				chatChannel,
				{ content: context, isConversation: true, gitHubReferenceSource: turn.message.text, currentTitle: lastApplied },
				lastApplied,
				apply,
				() => this._stateManager.getChatState(chatChannel)?.title === this._lastAppliedTitle.get(chatChannel),
				title => this._persistAutoTitle(channel, chatChannel, title),
			);
			return;
		}

		const state = this._stateManager.getSessionState(channel);
		if (!state || state.turns.length !== 1) {
			return;
		}
		const lastApplied = this._lastAppliedTitle.get(channel);
		if (lastApplied === undefined || state.title !== lastApplied) {
			return;
		}
		const turn = state.turns[0];
		const context = this._buildFirstTurnContext(turn);
		if (!context) {
			return;
		}
		const apply = (title: string) => {
			this._applyTitle(channel, title, t => this._stateManager.dispatchServerAction(channel, {
				type: ActionType.SessionTitleChanged,
				title: t,
			}));
			this._persistAutoTitleSource(channel, undefined);
		};
		this._generateTitleSoon(
			channel,
			{ content: context, isConversation: true, gitHubReferenceSource: turn.message.text, currentTitle: lastApplied },
			lastApplied,
			apply,
			() => this._stateManager.getSessionState(channel)?.title === this._lastAppliedTitle.get(channel),
			title => this._persistAutoTitle(channel, undefined, title),
		);
	}

	/**
	 * Generates a title for a freshly forked session or chat from its
	 * inherited conversation context. Forks copy the source history up to the
	 * fork point, so neither {@link seedTitleFromFirstMessage} nor
	 * {@link refineTitleFromFirstTurn} (which require an empty / single-turn
	 * state) ever fire for them. This is the fork equivalent, run once at fork
	 * time over the kept turns, so the new chat gets a content-derived title
	 * instead of permanently inheriting the source's `Forked: …` title.
	 *
	 * `fallbackTitle` is the title the caller already applied to the new
	 * session/chat (e.g. `Forked: <source>`); it is recorded as the
	 * last-applied title so a concurrent manual rename suppresses the
	 * generated title, and stays visible until generation completes. The
	 * context is bounded to {@link MAX_TITLE_CONTEXT_CHARS} (middle-truncated),
	 * so generation costs at most a single small-model call.
	 */
	generateForkedTitle(channel: ProtocolURI, chatChannel: ProtocolURI | undefined, turns: readonly Turn[], fallbackTitle: string, sourceTitle?: string): void {
		if (this._isEphemeralSession(channel)) {
			return;
		}
		if (this._isActiveAgentTitleGenerationEnabled(channel)) {
			this.markTitleAuto(channel, chatChannel, fallbackTitle);
			return;
		}
		const context = this._buildConversationContext(turns, sourceTitle);
		if (!context) {
			return;
		}

		const isAdditionalChat = !!chatChannel && isAhpChatChannel(chatChannel) && !isDefaultChatUri(chatChannel);
		if (isAdditionalChat) {
			const key = chatChannel;
			this._lastAppliedTitle.set(key, fallbackTitle);
			this._persistAutoTitleSource(channel, key);
			const apply = (title: string) => this._applyTitle(key, title, t => this._stateManager.updateChatTitle(channel, key, t));
			this._generateTitleSoon(
				key,
				{ content: context, isConversation: true },
				fallbackTitle,
				apply,
				() => this._stateManager.getChatState(key)?.title === this._lastAppliedTitle.get(key),
				title => this._persistAutoTitle(channel, key, title),
			);
			return;
		}

		this._lastAppliedTitle.set(channel, fallbackTitle);
		this._persistAutoTitleSource(channel, undefined);
		const apply = (title: string) => this._applyTitle(channel, title, t => this._stateManager.dispatchServerAction(channel, {
			type: ActionType.SessionTitleChanged,
			title: t,
		}));
		this._generateTitleSoon(
			channel,
			{ content: context, isConversation: true },
			fallbackTitle,
			apply,
			() => this._stateManager.getSessionState(channel)?.title === this._lastAppliedTitle.get(channel),
			title => this._persistAutoTitle(channel, undefined, title),
		);
	}

	private _applyTitle(key: ProtocolURI, title: string, dispatch: (title: string) => void): void {
		this._lastAppliedTitle.set(key, title);
		dispatch(title);
	}

	/**
	 * Generates a title for an external session whose provider surfaced it
	 * without one, from the user's first prompt. Such a session usually has no
	 * live state (it is materialized when opened), so the generated title is
	 * persisted and pushed onto its surfaced summary. A session that already
	 * carries a persisted title keeps it; a rename during generation cancels it.
	 *
	 * Unlike the other entry points this awaits generation, so the caller's
	 * deferred-work lane stays serialized against it.
	 */
	async generateExternalSessionTitle(session: ProtocolURI, userPrompt: string): Promise<void> {
		if (this._isEphemeralSession(session) || await this._readPersistedTitleMetadata(session, SESSION_CUSTOM_TITLE_KEY)) {
			return;
		}
		await this._startTitleGeneration(
			session,
			{ content: userPrompt, isConversation: false, gitHubReferenceSource: userPrompt },
			'',
			title => this._applyExternalSessionTitle(session, title),
			() => true,
			title => this._persistAutoTitle(session, undefined, title),
		);
	}

	private _applyExternalSessionTitle(session: ProtocolURI, title: string): void {
		if (this._stateManager.getSessionState(session)) {
			this._applySeedTitle(session, undefined, title);
		} else {
			this._applyTitle(session, title, t => this._stateManager.updateSurfacedSessionTitle(session, t));
		}
	}

	cancelTitleGeneration(session: ProtocolURI): void {
		this._cancelTitleGeneration(session);
	}

	clearSession(session: ProtocolURI, chatChannels: readonly ProtocolURI[]): void {
		for (const key of [session, buildDefaultChatUri(session), ...chatChannels]) {
			this._cancelTitleGeneration(key);
			this._lastAppliedTitle.delete(key);
			this._provisionalTitles.delete(key);
			this._autoTitles.delete(key);
			this._renamedTitles.delete(key);
		}
	}

	markTitleAuto(channel: ProtocolURI, chatChannel: ProtocolURI | undefined, title: string): void {
		const independentChat = this._independentChatChannel(channel, chatChannel);
		const key = independentChat ?? channel;
		this._lastAppliedTitle.set(key, title);
		this._autoTitles.add(key);
		this._renamedTitles.delete(key);
		this._persistAutoTitle(channel, independentChat, title);
	}

	markTitleRenamed(channel: ProtocolURI, chatChannel?: ProtocolURI): void {
		const key = this._independentChatChannel(channel, chatChannel) ?? channel;
		this._cancelTitleGeneration(key);
		this._autoTitles.delete(key);
		this._provisionalTitles.delete(key);
		this._renamedTitles.add(key);
	}

	async prepareInstructionForAgent(channel: ProtocolURI, chatChannel: ProtocolURI): Promise<string | undefined> {
		if (this._isEphemeralSession(channel)) {
			return undefined;
		}
		if (!this._isActiveAgentTitleGenerationEnabled(channel)) {
			return undefined;
		}
		const independentChat = this._independentChatChannel(channel, chatChannel);
		const key = independentChat ?? channel;
		if (this._renamedTitles.has(key)) {
			return undefined;
		}
		const sourceKey = independentChat ? customChatTitleSourceMetadataKey(independentChat) : SESSION_CUSTOM_TITLE_SOURCE_KEY;
		const source = await this._readPersistedTitleMetadata(channel, sourceKey);
		if (source === AGENT_HOST_TITLE_SOURCE_USER || source === AGENT_HOST_TITLE_SOURCE_AGENT) {
			this.markTitleRenamed(channel, independentChat);
			return undefined;
		}
		if (source !== AGENT_HOST_TITLE_SOURCE_AUTO && !this._autoTitles.has(key)) {
			return undefined;
		}

		return CHAT_RENAME_REMINDER;
	}

	private _generateTitleSoon(
		key: ProtocolURI,
		prompt: ITitlePromptContext,
		fallbackTitle: string,
		apply: (title: string) => void,
		currentTitleMatchesFallback: () => boolean,
		persist: (title: string) => void,
	): void {
		void this._startTitleGeneration(key, prompt, fallbackTitle, apply, currentTitleMatchesFallback, persist);
	}

	/** Starts generation and resolves once the title has been applied and persisted. */
	private _startTitleGeneration(
		key: ProtocolURI,
		prompt: ITitlePromptContext,
		fallbackTitle: string,
		apply: (title: string) => void,
		currentTitleMatchesFallback: () => boolean,
		persist: (title: string) => void,
	): Promise<void> {
		this._cancelTitleGeneration(key);
		const source = new CancellationTokenSource();
		this._titleGenerationCancellationSources.set(key, source);
		return this._generateTitle(key, prompt, fallbackTitle, apply, currentTitleMatchesFallback, persist, source.token).catch(err => {
			if (!source.token.isCancellationRequested) {
				this._logService.warn(`[AgentHostSessionTitleController] Failed to apply generated title for ${key}`, err);
			}
		}).finally(() => {
			if (this._titleGenerationCancellationSources.get(key) === source) {
				this._titleGenerationCancellationSources.delete(key);
				source.dispose();
			}
		});
	}

	private async _generateTitle(
		key: ProtocolURI,
		prompt: ITitlePromptContext,
		fallbackTitle: string,
		apply: (title: string) => void,
		currentTitleMatchesFallback: () => boolean,
		persist: (title: string) => void,
		token: CancellationToken,
	): Promise<void> {
		const generatedTitle = await this._generateTitleFromPrompt(prompt, token);
		if (token.isCancellationRequested || !generatedTitle) {
			return;
		}

		if (!currentTitleMatchesFallback()) {
			return;
		}

		if (generatedTitle !== fallbackTitle) {
			apply(generatedTitle);
		}
		persist(generatedTitle);
	}

	private async _generateTitleFromPrompt(prompt: ITitlePromptContext, token: CancellationToken): Promise<string | undefined> {
		return undefined;
	}

	/**
	 * Builds the first-turn context string for title refinement. The user's
	 * request is always kept (truncated in the middle only if it alone exceeds
	 * half the budget). Only normal text (markdown) response parts are
	 * considered — tool calls, reasoning, and other parts are ignored. If the
	 * combined text is over budget, the middle of the response is removed.
	 *
	 * @returns the context string, or `undefined` when the turn has no text
	 * response worth refining from (the opening message already produced a
	 * title in that case).
	 */
	private _buildFirstTurnContext(turn: Turn): string | undefined {
		const response = renderResponseMarkdown(turn.responseParts);
		if (!response) {
			return undefined;
		}

		const userBudget = Math.floor(MAX_TITLE_CONTEXT_CHARS / 2);
		let userRequest = turn.message.text.trim();
		if (userRequest.length > userBudget) {
			userRequest = truncateMiddle(userRequest, userBudget);
		}
		const userBlock = `User request:\n${userRequest}`;
		const responseLabel = '\n\nAgent response:\n';

		const responseBudget = Math.max(0, MAX_TITLE_CONTEXT_CHARS - userBlock.length - responseLabel.length);
		const trimmedResponse = response.length > responseBudget ? truncateMiddle(response, responseBudget) : response;

		return trimmedResponse ? `${userBlock}${responseLabel}${trimmedResponse}` : userBlock;
	}

	/**
	 * Builds a conversation context string for forked-title generation by
	 * concatenating each kept turn's user request and textual response. Only
	 * normal text (markdown) response parts are considered — tool calls,
	 * reasoning, and other parts are ignored, mirroring
	 * {@link _buildFirstTurnContext}. When the fork's `sourceTitle` is known, a
	 * short framing note is prepended so the model understands the conversation
	 * is a branch continued from an earlier chat. The conversation is
	 * middle-truncated to {@link MAX_TITLE_CONTEXT_CHARS} to bound model cost;
	 * the framing note is always preserved in full.
	 *
	 * @returns the context string, or `undefined` when no turn carries any
	 * text worth titling from.
	 */
	private _buildConversationContext(turns: readonly Turn[], sourceTitle?: string): string | undefined {
		const framedTitle = sourceTitle?.trim();
		const framing = framedTitle
			? `This conversation was branched from an earlier chat titled "${framedTitle}". The turns below, oldest first, are the inherited history up to the branch point.\n\n`
			: undefined;
		return buildConversationContext(turns, { maxChars: MAX_TITLE_CONTEXT_CHARS, framing });
	}

	private _persistSessionFlag(session: ProtocolURI, key: string, value: string): void {
		persistSessionMetadata(this._options.sessionDataService, this._logService, session, key, value);
	}

	private _isActiveAgentTitleGenerationEnabled(channel: ProtocolURI): boolean {
		const serverTools = this._stateManager.getSessionState(channel)?.serverTools;
		return serverTools
			? serverTools.some(tool => tool.name === SessionServerToolName.RenameChat)
			: this._options.isActiveAgentTitleGenerationEnabled?.() === true;
	}

	private _isEphemeralSession(channel: ProtocolURI): boolean {
		return this._stateManager.isEphemeralSession(channel);
	}

	private async _readPersistedTitleMetadata(session: ProtocolURI, key: string): Promise<string | undefined> {
		try {
			const ref = await this._options.sessionDataService.tryOpenDatabase?.(URI.parse(session));
			if (!ref) {
				return undefined;
			}
			try {
				return await ref.object.getMetadata(key);
			} finally {
				ref.dispose();
			}
		} catch (err) {
			this._logService.warn(`[AgentHostSessionTitleController] Failed to read title metadata '${key}'`, err);
			return undefined;
		}
	}

	private _cancelTitleGeneration(session: ProtocolURI): void {
		const source = this._titleGenerationCancellationSources.get(session);
		if (!source) {
			return;
		}
		source.dispose(true);
		this._titleGenerationCancellationSources.delete(session);
	}

	override dispose(): void {
		for (const source of this._titleGenerationCancellationSources.values()) {
			source.dispose(true);
		}
		this._titleGenerationCancellationSources.clear();
		this._lastAppliedTitle.clear();
		this._provisionalTitles.clear();
		this._autoTitles.clear();
		this._renamedTitles.clear();
		super.dispose();
	}
}
