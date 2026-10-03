/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentHostEnablementService } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, Workspace, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ChatPermissionLevel, getChatPermissionLevelFromDefaultConfiguration, getComputedDefaultSessionType, getDefaultNewChatSessionResource, getDefaultNewChatSessionType, IDefaultNewChatSessionTypeOptions, isEditorLocalAgentEnabled, isNewChatSessionTypeUsable, isVisibleEditorChatSessionType, recordUserSelectedSessionType, resolveDefaultNewChatSessionType } from '../../common/constants.js';
import { localChatSessionType, SessionType, IChatSessionsExtensionPoint, IChatSessionsService } from '../../common/chatSessionsService.js';
import { MockChatSessionsService } from './mockChatSessionsService.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { getRememberedSessionType, storeUserSelectedSessionType } from '../../common/chatSessionTypePreference.js';
import { getChatSessionType } from '../../common/model/chatUri.js';

suite('ChatConfiguration defaults', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const localWorkspace = createWorkspace(URI.file('/workspace'));

	function createWorkspace(...resources: URI[]): Workspace {
		return new Workspace(
			resources.map(resource => resource.toString()).join(','),
			resources.map(toWorkspaceFolder),
			false,
			null,
			() => false,
		);
	}

	function createChatSessionsService(...types: string[]): MockChatSessionsService {
		const service = new MockChatSessionsService();
		service.setContributions(types.map(type => ({
			type,
			name: type,
			displayName: type,
			description: type,
		} satisfies IChatSessionsExtensionPoint)));
		return service;
	}

	function resolveSessionType(
		configurationService: IConfigurationService,
		chatSessionsService: IChatSessionsService,
		storageService: IStorageService,
		workspace: Workspace,
		agentHostEnabled: boolean,
		options?: IDefaultNewChatSessionTypeOptions,
		managedSandboxEnforced = false,
	) {
		const accessor = disposables.add(new TestInstantiationService());
		accessor.set(IConfigurationService, configurationService);
		accessor.set(IChatSessionsService, chatSessionsService);
		accessor.set(IStorageService, storageService);
		accessor.set(IWorkspaceContextService, new TestContextService(workspace));
		accessor.set(IAgentHostEnablementService, { _serviceBrand: undefined, enabled: constObservable(agentHostEnabled), managedSandboxEnforced: constObservable(managedSandboxEnforced) });
		return resolveDefaultNewChatSessionType(accessor, options);
	}

	test('default permission configuration maps setting values to Agent Host values', () => {
		assert.deepStrictEqual({
			manual: getChatPermissionLevelFromDefaultConfiguration('manual'),
			assisted: getChatPermissionLevelFromDefaultConfiguration('assisted'),
			allowAll: getChatPermissionLevelFromDefaultConfiguration('allowAll'),
			legacyDefault: getChatPermissionLevelFromDefaultConfiguration('default'),
			legacyAutoApprove: getChatPermissionLevelFromDefaultConfiguration('autoApprove'),
			invalid: getChatPermissionLevelFromDefaultConfiguration('invalid'),
		}, {
			manual: ChatPermissionLevel.Default,
			assisted: ChatPermissionLevel.Assisted,
			allowAll: ChatPermissionLevel.AutoApprove,
			legacyDefault: ChatPermissionLevel.Default,
			legacyAutoApprove: ChatPermissionLevel.AutoApprove,
			invalid: undefined,
		});
	});

	test('editor default returns local when agent host disabled and local enabled', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, false),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false),
			localVisible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, localWorkspace),
		}, {
			computed: localChatSessionType,
			rememberedAware: localChatSessionType,
			localVisible: true,
		});
	});

	test('editor default stays local when the agent host is enabled without a managed sandbox floor', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// Without a managed sandbox floor the computed default remains the local harness.
		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, true),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true),
		}, {
			computed: localChatSessionType,
			rememberedAware: localChatSessionType,
		});
	});

	test('remembered extension host Copilot CLI falls back for a new chat', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.CopilotCLI, SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.CopilotCLI, true);

		assert.deepStrictEqual({
			remembered: getRememberedSessionType(storageService),
			rememberedUsable: isNewChatSessionTypeUsable(SessionType.CopilotCLI, configurationService, chatSessionsService, localWorkspace),
			newSessionType: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true),
		}, {
			remembered: SessionType.CopilotCLI,
			rememberedUsable: false,
			newSessionType: localChatSessionType,
		});
	});

	test('current extension host Copilot CLI is not inherited by a new chat', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.CopilotCLI, SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual(
			resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.CopilotCLI }),
			{ sessionType: localChatSessionType }
		);
	});

	test('editor default keeps local as last resort without any provider', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService();
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, false),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false),
			localVisible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, localWorkspace),
		}, {
			computed: localChatSessionType,
			rememberedAware: localChatSessionType,
			localVisible: true,
		});
	});

	test('remembered non-local selection wins over the computed default', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, true);

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, true),
			remembered: getRememberedSessionType(storageService),
			rememberedAware: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }),
		}, {
			computed: localChatSessionType,
			remembered: SessionType.AgentHostClaude,
			rememberedAware: { sessionType: SessionType.AgentHostClaude },
		});
	});

	test('explicit override wins over remembered selection', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, false);

		assert.deepStrictEqual({
			remembered: getRememberedSessionType(storageService),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false, { explicitOverride: SessionType.AgentHostCopilot }),
		}, {
			remembered: SessionType.AgentHostClaude,
			rememberedAware: SessionType.AgentHostCopilot,
		});
	});

	test('current session type is fallback after remembered selection', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			withoutRemembered: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostCopilot }),
		}, {
			withoutRemembered: SessionType.AgentHostCopilot,
		});

		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, false);

		assert.deepStrictEqual({
			withRemembered: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostCopilot }),
		}, {
			withRemembered: SessionType.AgentHostClaude,
		});
	});

	test('managed sandbox floor replaces local on every new chat', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			firstResolve: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
			secondResolve: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
		}, {
			firstResolve: { sessionType: SessionType.AgentHostCopilot },
			secondResolve: { sessionType: SessionType.AgentHostCopilot },
		});
	});

	test('managed sandbox preference is skipped when the agent host is disabled', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// With the agent host disabled (e.g. on web), the Copilot harness is unavailable.
		const resolved = resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false, { currentSessionType: localChatSessionType }, true);

		assert.deepStrictEqual({
			resolved,
		}, {
			resolved: { sessionType: localChatSessionType },
		});
	});

	test('managed sandbox floor preserves Claude and Codex selections', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude, SessionType.AgentHostCodex);
		const storageService = disposables.add(new TestStorageService());

		const currentClaude = resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostClaude }, true);
		const currentCodex = resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostCodex }, true);
		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, true);
		const rememberedClaude = resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true);
		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostCodex, true);

		assert.deepStrictEqual({
			currentClaude,
			currentCodex,
			rememberedClaude,
			rememberedCodex: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
		}, {
			currentClaude: { sessionType: SessionType.AgentHostClaude },
			currentCodex: { sessionType: SessionType.AgentHostCodex },
			rememberedClaude: { sessionType: SessionType.AgentHostClaude },
			rememberedCodex: { sessionType: SessionType.AgentHostCodex },
		});
	});

	test('selecting computed default clears remembered selection', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, true);
		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, localChatSessionType, true);

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, true),
			remembered: getRememberedSessionType(storageService),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true),
		}, {
			computed: localChatSessionType,
			remembered: undefined,
			rememberedAware: localChatSessionType,
		});
	});

	test('managed sandbox floor overrides a remembered local selection every time', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// A local selection remembered from before the floor was mandated is no longer usable.
		storeUserSelectedSessionType(storageService, localChatSessionType);

		assert.deepStrictEqual({
			firstResolve: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
			secondResolve: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
		}, {
			firstResolve: { sessionType: SessionType.AgentHostCopilot },
			secondResolve: { sessionType: SessionType.AgentHostCopilot },
		});
	});

	test('new chat from a local session preserves local', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// No remembered selection: the current session type wins (session preservation).
		assert.deepStrictEqual({
			resolved: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }),
		}, {
			resolved: { sessionType: localChatSessionType },
		});
	});

	test('explicit New Local Chat wins over a non-local current session', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// "New Local Chat" from a Copilot session must resolve to local: the explicit
		// override outranks both the current session type and the computed default,
		// so the clear path opens a local session instead of dropping the request.
		assert.deepStrictEqual({
			resolved: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { explicitOverride: localChatSessionType, currentSessionType: SessionType.AgentHostCopilot }),
		}, {
			resolved: { sessionType: localChatSessionType },
		});
	});

	test('virtual workspace defaults implicit new chats to local', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const rememberedStorageService = disposables.add(new TestStorageService());
		const currentStorageService = disposables.add(new TestStorageService());
		const workspace = createWorkspace(URI.parse('vscode-vfs://github/microsoft/vscode'));
		recordUserSelectedSessionType(rememberedStorageService, configurationService, chatSessionsService, workspace, SessionType.AgentHostClaude, true);

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, workspace, true),
			remembered: getRememberedSessionType(rememberedStorageService),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, rememberedStorageService, workspace, true),
			currentAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, currentStorageService, workspace, true, { currentSessionType: SessionType.AgentHostCopilot }),
			resolvedRemembered: resolveSessionType(configurationService, chatSessionsService, rememberedStorageService, workspace, true, { currentSessionType: SessionType.AgentHostCopilot }),
			resolvedCurrent: resolveSessionType(configurationService, chatSessionsService, currentStorageService, workspace, true, { currentSessionType: SessionType.AgentHostCopilot }),
			resolvedPreferMigration: resolveSessionType(configurationService, chatSessionsService, currentStorageService, workspace, true, { currentSessionType: localChatSessionType }),
			explicitOverride: resolveSessionType(configurationService, chatSessionsService, currentStorageService, workspace, true, { explicitOverride: SessionType.AgentHostClaude }),
			localVisible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, workspace),
			localRememberedUsable: isNewChatSessionTypeUsable(localChatSessionType, configurationService, chatSessionsService, workspace),
		}, {
			computed: localChatSessionType,
			remembered: SessionType.AgentHostClaude,
			rememberedAware: localChatSessionType,
			currentAware: localChatSessionType,
			resolvedRemembered: { sessionType: localChatSessionType },
			resolvedCurrent: { sessionType: localChatSessionType },
			resolvedPreferMigration: { sessionType: localChatSessionType },
			explicitOverride: { sessionType: SessionType.AgentHostClaude },
			localVisible: true,
			localRememberedUsable: true,
		});
	});

	test('remembered agent host is usable before contribution registers', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService();
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			agentHost: isNewChatSessionTypeUsable(SessionType.AgentHostClaude, configurationService, chatSessionsService, localWorkspace),
			agentHostCurrent: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostClaude }),
			extensionContributed: isNewChatSessionTypeUsable('my-extension-agent', configurationService, chatSessionsService, localWorkspace),
		}, {
			agentHost: true,
			agentHostCurrent: { sessionType: SessionType.AgentHostClaude },
			extensionContributed: false,
		});
	});

	test('disabled Agent Host is not inherited from remembered or current session types', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService();
		const storageService = disposables.add(new TestStorageService());
		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, true);

		assert.deepStrictEqual({
			usable: isNewChatSessionTypeUsable(SessionType.AgentHostClaude, configurationService, chatSessionsService, localWorkspace, false),
			remembered: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false),
			current: resolveSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false, { currentSessionType: SessionType.AgentHostClaude }),
		}, {
			usable: false,
			remembered: localChatSessionType,
			current: { sessionType: localChatSessionType },
		});
	});

	test('managed sandbox floor disables the local agent outside virtual workspaces', () => {
		const configurationService = new TestConfigurationService();
		const remoteWorkspace = createWorkspace(URI.parse('vscode-remote://ssh-remote+test/workspace'));
		const remoteRepositoriesWorkspace = createWorkspace(URI.parse('vscode-vfs://github/microsoft/vscode'));
		const customVirtualWorkspace = createWorkspace(URI.parse('custom-vfs://provider/workspace'));
		const mixedWorkspace = createWorkspace(URI.file('/workspace'), URI.parse('custom-vfs://provider/workspace'));

		assert.deepStrictEqual({
			local: isEditorLocalAgentEnabled(configurationService, localWorkspace, true),
			remote: isEditorLocalAgentEnabled(configurationService, remoteWorkspace, true),
			remoteRepositories: isEditorLocalAgentEnabled(configurationService, remoteRepositoriesWorkspace, true),
			customVirtual: isEditorLocalAgentEnabled(configurationService, customVirtualWorkspace, true),
			mixed: isEditorLocalAgentEnabled(configurationService, mixedWorkspace, true),
		}, {
			local: false,
			remote: false,
			remoteRepositories: true,
			customVirtual: true,
			mixed: false,
		});
	});

	test('managed sandbox floor hides the local harness and defaults to the Copilot SDK', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		// An enterprise-mandated sandbox floor implies both the Copilot default and the
		// retired local harness.
		assert.deepStrictEqual({
			localEnabled: isEditorLocalAgentEnabled(configurationService, localWorkspace, true),
			localVisible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, localWorkspace, true),
			localUsable: isNewChatSessionTypeUsable(localChatSessionType, configurationService, chatSessionsService, localWorkspace, true, true),
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, true, true),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, undefined, true),
			fromLocal: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
		}, {
			localEnabled: false,
			localVisible: false,
			localUsable: false,
			computed: SessionType.AgentHostCopilot,
			rememberedAware: SessionType.AgentHostCopilot,
			fromLocal: SessionType.AgentHostCopilot,
		});
	});

	test('managed sandbox floor reaches the New Chat entry points and overrides remembered local', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		// A local harness remembered from before the floor was mandated must not keep winning:
		// otherwise the picker hides local while New Chat keeps opening local sessions.
		storeUserSelectedSessionType(storageService, localChatSessionType);

		assert.deepStrictEqual({
			remembered: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, undefined, true),
			resource: getChatSessionType(getDefaultNewChatSessionResource(configurationService, chatSessionsService, storageService, localWorkspace, true, undefined, true)),
		}, {
			remembered: SessionType.AgentHostCopilot,
			resource: SessionType.AgentHostCopilot,
		});
	});

	test('managed sandbox floor does not override remembered Claude and Codex selections', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot, SessionType.AgentHostClaude, SessionType.AgentHostCodex);
		const storageService = disposables.add(new TestStorageService());

		const currentCodex = getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: SessionType.AgentHostCodex }, true);
		recordUserSelectedSessionType(storageService, configurationService, chatSessionsService, localWorkspace, SessionType.AgentHostClaude, true);

		assert.deepStrictEqual({
			currentCodex,
			rememberedClaude: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, true),
		}, {
			currentCodex: SessionType.AgentHostCodex,
			rememberedClaude: SessionType.AgentHostClaude,
		});
	});

	test('no managed sandbox floor keeps the local harness', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			localEnabled: isEditorLocalAgentEnabled(configurationService, localWorkspace, false),
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, true, false),
			resolved: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, true, { currentSessionType: localChatSessionType }, false),
		}, {
			localEnabled: true,
			computed: localChatSessionType,
			resolved: localChatSessionType,
		});
	});

	test('managed sandbox floor keeps local when Agent Host is disabled', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostClaude);
		const storageService = disposables.add(new TestStorageService());

		assert.deepStrictEqual({
			visible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, localWorkspace, true, false),
			usable: isNewChatSessionTypeUsable(localChatSessionType, configurationService, chatSessionsService, localWorkspace, false, true),
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, localWorkspace, false, true),
			resolved: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, localWorkspace, false, { currentSessionType: localChatSessionType }, true),
		}, {
			visible: true,
			usable: true,
			computed: localChatSessionType,
			resolved: localChatSessionType,
		});
	});

	test('virtual workspace keeps local available when the sandbox floor is managed', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const workspace = createWorkspace(URI.parse('vscode-vfs://github/microsoft/vscode'));

		assert.deepStrictEqual({
			localEnabled: isEditorLocalAgentEnabled(configurationService, workspace, true),
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, workspace, true, true),
		}, {
			localEnabled: true,
			computed: localChatSessionType,
		});
	});

	test('virtual workspace keeps local available', () => {
		const configurationService = new TestConfigurationService();
		const chatSessionsService = createChatSessionsService(SessionType.AgentHostCopilot);
		const storageService = disposables.add(new TestStorageService());
		const workspace = createWorkspace(URI.parse('vscode-vfs://github/microsoft/vscode'));

		assert.deepStrictEqual({
			computed: getComputedDefaultSessionType(configurationService, chatSessionsService, workspace, false),
			rememberedAware: getDefaultNewChatSessionType(configurationService, chatSessionsService, storageService, workspace, false),
			localVisible: isVisibleEditorChatSessionType(localChatSessionType, configurationService, chatSessionsService, workspace),
			localRememberedUsable: isNewChatSessionTypeUsable(localChatSessionType, configurationService, chatSessionsService, workspace),
		}, {
			computed: localChatSessionType,
			rememberedAware: localChatSessionType,
			localVisible: true,
			localRememberedUsable: true,
		});
	});
});
