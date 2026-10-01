/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, mkdir } from 'fs/promises';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../base/common/map.js';
import { joinPath } from '../../../../base/common/resources.js';
import { compare as compareStrings } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname as nodeDirname, join as nodeJoin } from '../../../../base/common/path.js';
import { FileOperationResult, IFileService, IFileStat, IFileStatWithMetadata, toFileOperationResult } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * The kinds of customizations the agent host discovers from disk.
 *
 * Re-declared on the platform side so this module has no dependency on the
 * workbench-side `PromptsType` enum.
 */
export const enum DiscoveredType {
	Agent = 'agent',
	Skill = 'skill',
	Instruction = 'instruction',
	Hook = 'hook',
	AgentInstruction = 'agentInstruction',
}

export interface IDiscoveredDirectory {
	readonly uri: URI;
	readonly type: DiscoveredType;
	readonly name: string;
	readonly writable: boolean;
	readonly files: readonly IDiscoveredFile[];
}

export interface IDiscoveredFile {
	readonly uri: URI;
	readonly etag: string;
}

export function areDiscoveredDirectoriesEqual(a: readonly IDiscoveredDirectory[], b: readonly IDiscoveredDirectory[]): boolean {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		const left = a[i];
		const right = b[i];
		if (left.type !== right.type || left.uri.toString() !== right.uri.toString() || !areDiscoveredFilesEqual(left.files, right.files)) {
			return false;
		}
	}

	return true;
}

function compareDiscoveredDirectory(a: IDiscoveredDirectory, b: IDiscoveredDirectory): number {
	const byType = compareStrings(a.type, b.type);
	if (byType !== 0) {
		return byType;
	}
	return compareStrings(a.uri.toString(), b.uri.toString());
}

function areDiscoveredFilesEqual(a: readonly IDiscoveredFile[], b: readonly IDiscoveredFile[]): boolean {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		const left = a[i];
		const right = b[i];
		if (left.uri.toString() !== right.uri.toString() || left.etag !== right.etag) {
			return false;
		}
	}

	return true;
}

function compareDiscoveredFile(a: IDiscoveredFile, b: IDiscoveredFile): number {
	return compareStrings(a.uri.toString(), b.uri.toString());
}

/**
 * Maximum recursion depth when traversing subdirectories for instruction files.
 */
const MAX_INSTRUCTIONS_RECURSION_DEPTH = 5;
const MAX_HOOKS_RECURSION_DEPTH = 8;

const AGENT_FILE_SUFFIX = '.agent.md';
const MARKDOWN_SUFFIX = '.md';
const INSTRUCTION_FILE_SUFFIX = '.instructions.md';
const HOOK_FILE_SUFFIX = '.json';
const SKILL_FILENAME = 'SKILL.md';
const README_FILENAME = 'README.md';
const CUSTOMIZATION_DISCOVERY_DEBUG_LOG_PATH = undefined; //'/tmp/copilot-customization-discovery-debug.log';

interface ISearchRoot {
	readonly path: readonly string[];
	readonly type: DiscoveredType;
	readonly recursive?: boolean; // whether to watch recursively for changes (defaults to false)
	readonly name: string;
}

interface IFixedDiscoveryFile {
	readonly path: readonly string[];
	readonly filenames: string[];
	readonly type: DiscoveredType;
}

/**
 * Builds the list of search roots for a given working directory and user home.
 * Skills require a depth-2 scan (`<skillDir>/SKILL.md`), agents are scanned at
 * a single directory depth, and instructions/hooks are recursively scanned.
 */
/**
 * PiCode's own profile — `<dist>/data/pi-agent` — resolved from the running
 * distribution. The extension host's executable is the distribution's binary
 * (`<dist>/PiCode.exe`), so the profile sits beside it. `undefined` everywhere
 * else (plain electron, tests), so nothing phantom is scanned.
 */
const PICODE_PROFILE_ROOT: string | undefined = (() => {
	if (!/picode/i.test(process.execPath)) {
		return undefined;
	}
	// dirname(PiCode.exe) = <dist>; the profile lives right beside the binary.
	return nodeJoin(nodeDirname(process.execPath), 'data', 'pi-agent');
})();

const searchRoots: { workspace: ISearchRoot[]; user: ISearchRoot[]; picode: ISearchRoot[] } = {
	workspace: [
		{ path: ['.github', 'agents'], type: DiscoveredType.Agent, name: '.github' },
		{ path: ['.claude', 'agents'], type: DiscoveredType.Agent, name: '.claude' },
		{ path: ['.github', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '.github' },
		{ path: ['.agents', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '.agents' },
		{ path: ['.claude', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '.claude' },
		{ path: ['.github', 'instructions'], recursive: true, type: DiscoveredType.Instruction, name: '.github' },
		{ path: ['.github', 'hooks'], recursive: true, type: DiscoveredType.Hook, name: '.github' },

		// PiCode: pi's own project conventions. This product's agent is pi, so the
		// customizations it loads have to be discoverable in the core; without these the
		// table only knows Copilot's and Claude's directories (`.github`, `.claude`,
		// `.agents`) and a pi project's own agents and skills are invisible to the hub.
		// `.pi/prompts` is deliberately absent: this table has no `Prompt` kind, and filing
		// prompt templates as instructions would say something false about them.
		{ path: ['.pi', 'agents'], type: DiscoveredType.Agent, name: '.pi' },
		{ path: ['.pi', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '.pi' },
	],
	user: [
		{ path: ['.copilot', 'agents'], type: DiscoveredType.Agent, name: '~/.copilot' },
		{ path: ['.agents', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '~/.agents' },
		{ path: ['.copilot', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '~/.copilot' },
		{ path: ['.copilot', 'instructions'], recursive: true, type: DiscoveredType.Instruction, name: '~/.copilot' },
		{ path: ['.copilot', 'hooks'], recursive: true, type: DiscoveredType.Hook, name: '~/.copilot' },

		// PiCode: pi's own user profile, which is `~/.pi/agent` (see
		// `environment-variables.md`, `PI_CODING_AGENT_DIR`). This is also where
		// gentle-ai's own installer puts its subagents, so listing this directory is what
		// brings the whole harness into the hub without an extension doing it.
		{ path: ['.pi', 'agent', 'agents'], type: DiscoveredType.Agent, name: '~/.pi/agent' },
		{ path: ['.pi', 'agent', 'skills'], recursive: true, type: DiscoveredType.Skill, name: '~/.pi/agent' },
	],

	// PiCode's own profile, wherever the distribution runs from. gentle-pi ships its
	// agents and skills inside its npm package, and the wizard installs that package
	// here — so this root is what makes the whole Gentle AI harness visible to the
	// editor's hub, completions and agent picker. Empty when not running as PiCode.
	picode: PICODE_PROFILE_ROOT === undefined ? [] : [
		{ path: ['agents'], type: DiscoveredType.Agent, name: 'PiCode profile' },
		{ path: ['skills'], recursive: true, type: DiscoveredType.Skill, name: 'PiCode profile' },
		{ path: ['npm', 'node_modules', 'gentle-pi', 'assets', 'agents'], type: DiscoveredType.Agent, name: 'gentle-pi' },
		{ path: ['npm', 'node_modules', 'gentle-pi', 'skills'], recursive: true, type: DiscoveredType.Skill, name: 'gentle-pi' },
	],
};


/**
 * Builds the list of instruction file candidates used by the Copilot CLI.
 *
 * Returns paths with filenames for workspace and user-home
 * locations
 */
const fixedDiscoveryFiles: { workspace: IFixedDiscoveryFile[]; user: IFixedDiscoveryFile[] } = {
	workspace: [
		{ path: ['.github'], filenames: ['copilot-instructions.md'], type: DiscoveredType.AgentInstruction },
		{ path: [], filenames: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'], type: DiscoveredType.AgentInstruction },
		{ path: ['.claude'], filenames: ['CLAUDE.md'], type: DiscoveredType.AgentInstruction },
		{ path: ['.github', 'copilot'], filenames: ['settings.json', 'settings.local.json'], type: DiscoveredType.Hook },
		{ path: ['.claude'], filenames: ['settings.json', 'settings.local.json'], type: DiscoveredType.Hook },
	],
	user: [
		{ path: ['.copilot'], filenames: ['copilot-instructions.md'], type: DiscoveredType.AgentInstruction },
	],
};

// Back-compat alias for tests and callers that referenced the old symbol name.
const agentInstructions = fixedDiscoveryFiles;

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

interface IWatchSpec {
	readonly recursive: boolean;
	readonly resourcesToWatch: ResourceSet;
}

/**
 * Register a watcher for `watchUri` and add `resourceToWatch` to its set of
 * trigger URIs. If a non-recursive entry already exists and `recursive` is
 * true, upgrade it to recursive while preserving the accumulated trigger URIs.
 */
function addWatch(map: ResourceMap<IWatchSpec>, watchUri: URI, recursive: boolean, resourceToWatch: URI): void {
	let entry = map.get(watchUri);
	if (!entry) {
		entry = { recursive, resourcesToWatch: new ResourceSet() };
		map.set(watchUri, entry);
	} else if (recursive && !entry.recursive) {
		entry = { recursive: true, resourcesToWatch: entry.resourcesToWatch };
		map.set(watchUri, entry);
	}
	entry.resourcesToWatch.add(resourceToWatch);
}

/**
 * Discovers customization files (agents, skills, instructions, and hooks)
 * under well-known directories of the session's working directories and the
 * user's home, and emits {@link onDidChange} when any of those directories
 * change on disk.
 *
 *
 * Workspace roots take precedence over user-home roots when the same URI is
 * discovered through multiple paths (de-duped by URI).
 *
 * `_workingDirectories` MUST be **non-empty** and **primary-first**: index 0 is
 * the primary root (the process cwd / worktree) and is used as the anchor for
 * sources the SDK does not attribute to a specific root (see {@link discoverRules})
 * and as the sole root for hooks (see {@link _hookWorkingDirectories}); indices
 * 1..N are the additional multi-root folders. The constructor asserts this so a
 * caller that passes an empty set fails fast with a clear error instead of a
 * confusing `undefined`-root crash deep inside discovery.
 */
export class SessionCustomizationDiscovery extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _watchers = new ResourceMap<IWatchSpec & { readonly disposable: IDisposable }>();

	constructor(
		private readonly _workingDirectories: readonly URI[],
		private readonly _userHome: URI,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		if (_workingDirectories.length === 0) {
			// Dispose the base store before throwing so a rejected construction
			// does not leak a tracked (never-disposed) disposable.
			this.dispose();
			throw new Error('SessionCustomizationDiscovery requires at least one working directory (index 0 = primary root).');
		}
		this._register({ dispose: () => this._disposeAllWatchers() });
		this._register(this._fileService.onDidFilesChange(e => {
			for (const watcher of this._watchers.values()) {
				for (const uri of watcher.resourcesToWatch) {
					if (e.affects(uri)) {
						this._scheduleRefresh();
						return;
					}
				}
			}
		}));
	}

	private _scheduleRefresh(): void {
		this._onDidChange.fire();
	}

	/**
	 * The working-directory roots that hooks are discovered from.
	 *
	 * **Hooks are discovered from the PRIMARY working directory only** (index 0 of
	 * {@link _workingDirectories}, which callers MUST order primary-first). Hooks
	 * from non-primary roots are intentionally NOT discovered because the Copilot
	 * agent currently applies hooks from a single primary directory only. Every
	 * other customization types (agents, skills, and instructions) are discovered
	 * across all roots.
	 *
	 * Example: for roots `[B, A, C]` (with `B` selected as primary), hooks are
	 * discovered from `B` only; hooks under `A`/`C` are ignored.
	 *
	 * This may expand to all roots in the future — see `MULTI_ROOT_CHANGES.md`.
	 */
	private get _hookWorkingDirectories(): readonly URI[] {
		return this._workingDirectories.slice(0, 1);
	}

	private async writeCustomizationDiscoveryDebugLog(payload: Record<string, unknown>): Promise<void> {
		if (!CUSTOMIZATION_DISCOVERY_DEBUG_LOG_PATH) {
			return;
		}

		try {
			await mkdir(nodeDirname(CUSTOMIZATION_DISCOVERY_DEBUG_LOG_PATH), { recursive: true });
			await appendFile(CUSTOMIZATION_DISCOVERY_DEBUG_LOG_PATH, `${JSON.stringify({
				timestamp: new Date().toISOString(),
				...payload,
			}, undefined, 2)}\n`, 'utf8');
		} catch (err) {
			this._logService.error(`[SessionCustomizationDiscovery] Failed to write discovery debug log: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Returns the list of discovered customization directories and files in a sorted way.
	 * Also sets up watchers for all discovered root directories (recursively if specified by the root or if already watching recursively).
	 * Each call performs a fresh scan scoped to the provided cancellation token.
	 */
	public async scan(token: CancellationToken): Promise<readonly IDiscoveredDirectory[]> {
		await this.writeCustomizationDiscoveryDebugLog({
			method: 'scan',
			workingDirectories: this._workingDirectories.map(d => d.toString()),
			userHome: this._userHome.toString(),
		});
		throwIfCancelled(token);

		const nextWatchRootUris = new ResourceMap<IWatchSpec>();
		const seen = new ResourceSet();
		const result: IDiscoveredDirectory[] = [];

		// Workspace first so it wins on URI conflicts. Hooks are discovered from the
		// PRIMARY working directory only (Copilot limitation — see _hookWorkingDirectories);
		// every other type is discovered across all roots.
		const workspaceFixedHook = fixedDiscoveryFiles.workspace.filter(root => root.type === DiscoveredType.Hook);
		const workspaceFixedNonHook = fixedDiscoveryFiles.workspace.filter(root => root.type !== DiscoveredType.Hook);
		await Promise.all([
			...searchRoots.workspace.flatMap(root =>
				(root.type === DiscoveredType.Hook ? this._hookWorkingDirectories : this._workingDirectories)
					.map(workingDirectory => this._scanRoot(workingDirectory, root, seen, result, nextWatchRootUris, token))),
			...searchRoots.user.map(root => this._scanRoot(this._userHome, root, seen, result, nextWatchRootUris, token)),

			...(PICODE_PROFILE_ROOT === undefined ? [] : searchRoots.picode.map(root => this._scanRoot(URI.file(PICODE_PROFILE_ROOT), root, seen, result, nextWatchRootUris, token))),
			...this._workingDirectories.map(workingDirectory =>
				this._scanFixedDiscoveryFiles(workingDirectory, workspaceFixedNonHook, seen, result, nextWatchRootUris, token)),
			...this._hookWorkingDirectories.map(workingDirectory =>
				this._scanFixedDiscoveryFiles(workingDirectory, workspaceFixedHook, seen, result, nextWatchRootUris, token)),
			this._scanFixedDiscoveryFiles(this._userHome, fixedDiscoveryFiles.user, seen, result, nextWatchRootUris, token)
		]);

		throwIfCancelled(token);

		this._reconcileWatchers(nextWatchRootUris);
		const sortedResult = result.sort(compareDiscoveredDirectory);
		await this.writeCustomizationDiscoveryDebugLog({
			method: 'scan',
			result: sortedResult.map(directory => ({
				type: directory.type,
				uri: directory.uri.toString(),
				files: directory.files.map(file => file.uri.toString()),
			})),
		});
		return sortedResult;
	}

	/**
	 * Walk the ancestor chain of `path` from `base`. For every ancestor
	 * directory that exists, register a non-recursive watcher whose trigger
	 * URI is the next path segment, so the handler fires when an intermediate
	 * directory (e.g. `.github`, `.github/agents`, `.copilot`) is created and
	 * a re-scan is needed to pick up newly-discoverable content.
	 *
	 * Returns true when every ancestor exists as a directory (i.e. the leaf
	 * may exist). Returns false when an ancestor is missing or not a directory,
	 * in which case the caller can short-circuit.
	 */
	private async _watchAncestors(base: URI, path: readonly string[], watchRootUris: ResourceMap<IWatchSpec>, token: CancellationToken): Promise<boolean> {
		let current = base;
		for (const segment of path) {
			const parent = current;
			const child = joinPath(parent, segment);
			if (!watchRootUris.has(parent)) {
				throwIfCancelled(token);
				try {
					const stat = await this._fileService.resolve(parent);
					if (!stat.isDirectory) {
						return false;
					}
				} catch {
					return false;
				}
			}
			addWatch(watchRootUris, parent, false, child);
			current = child;
		}
		return true;
	}

	private _reconcileWatchers(nextWatchRootUris: ResourceMap<IWatchSpec>): void {
		// Dispose watchers that are gone or whose recursive flag changed.
		for (const [rootUri, watcher] of this._watchers.entries()) {
			const next = nextWatchRootUris.get(rootUri);
			if (!next || next.recursive !== watcher.recursive) {
				watcher.disposable.dispose();
				this._watchers.delete(rootUri);
			}
		}

		for (const [rootUri, next] of nextWatchRootUris.entries()) {
			const existing = this._watchers.get(rootUri);
			if (existing) {
				// Refresh trigger URIs in place; the underlying watcher is unchanged.
				existing.resourcesToWatch.clear();
				for (const uri of next.resourcesToWatch) {
					existing.resourcesToWatch.add(uri);
				}
				continue;
			}
			try {
				const disposable = this._fileService.watch(rootUri, { recursive: next.recursive, excludes: [] });
				this._watchers.set(rootUri, { recursive: next.recursive, resourcesToWatch: next.resourcesToWatch, disposable });
			} catch (err) {
				this._logService.warn(`[SessionCustomizationDiscovery] Failed to watch '${rootUri.toString()}': ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private _disposeAllWatchers(): void {
		for (const watcher of this._watchers.values()) {
			watcher.disposable.dispose();
		}
		this._watchers.clear();
	}

	/**
	 * For fixed discovery files (e.g. AGENTS.md, copilot-instructions.md,
	 * settings.json), create one discovered directory per type at the base.
	 */
	private async _scanFixedDiscoveryFiles(base: URI, roots: IFixedDiscoveryFile[], seen: ResourceSet, result: IDiscoveredDirectory[], watchRootUris: ResourceMap<IWatchSpec>, token: CancellationToken): Promise<void> {
		const filesByType = new Map<DiscoveredType, IDiscoveredFile[]>();
		await Promise.all(roots.map(async root => {
			throwIfCancelled(token);

			if (!await this._watchAncestors(base, root.path, watchRootUris, token)) {
				return;
			}

			const rootUri = joinPath(base, ...root.path);
			let stat: IFileStatWithMetadata;
			try {
				stat = await this._fileService.resolve(rootUri, { resolveMetadata: true });
			} catch {
				// Root does not exist (or is unreadable) — nothing to discover or watch.
				return;
			}
			if (!stat.isDirectory || !stat.children) {
				return;
			}

			// Trigger refresh only for the specific filenames this root cares about
			// (e.g. AGENTS.md at the workspace root) — not for every direct child.
			for (const filename of root.filenames) {
				addWatch(watchRootUris, rootUri, false, joinPath(rootUri, filename));
			}
			for (const entry of stat.children) {
				throwIfCancelled(token);

				if (entry.isFile && root.filenames.includes(entry.name)) {
					const uri = joinPath(rootUri, entry.name);
					if (!seen.has(uri)) {
						seen.add(uri);
						const files = filesByType.get(root.type) ?? [];
						files.push({ uri, etag: entry.etag });
						filesByType.set(root.type, files);
					}
				}
			}
		}));

		for (const [type, files] of filesByType.entries()) {
			if (files.length > 0) {
				result.push({ uri: base, type, files: files.sort(compareDiscoveredFile), name: '', writable: false });
			}
		}
	}

	private async _scanRoot(base: URI, root: ISearchRoot, seen: ResourceSet, result: IDiscoveredDirectory[], watchRootUris: ResourceMap<IWatchSpec>, token: CancellationToken): Promise<void> {
		throwIfCancelled(token);

		const rootUri = joinPath(base, ...root.path);
		let stat: IFileStatWithMetadata | undefined = undefined;
		let children: IFileStatWithMetadata[] = [];
		try {
			stat = await this._fileService.resolve(rootUri, { resolveMetadata: true });
			children = stat.children ?? [];
		} catch {
			// Root does not exist (or is unreadable) — still discover it as a possible source folder.
		}

		// Filenames are dynamic for these roots, so we watch the whole directory.
		// `addWatch` upgrades to recursive if any root requests it.
		await this._watchAncestors(base, root.path, watchRootUris, token);
		addWatch(watchRootUris, rootUri, root.recursive ?? false, rootUri);

		if (root.type === DiscoveredType.Skill) {
			const files: IDiscoveredFile[] = [];
			await Promise.all(children.map(async child => {
				throwIfCancelled(token);

				if (child.isDirectory) {
					const skillFile = joinPath(child.resource, SKILL_FILENAME);
					try {
						const skillStat = await this._fileService.resolve(skillFile, { resolveMetadata: true });
						if (skillStat.isFile && !seen.has(skillFile)) {
							seen.add(skillFile);
							files.push({ uri: skillFile, etag: skillStat.etag });
						}
					} catch {
						// SKILL.md missing — skip this skill directory.
					}
				}
			}));
			result.push({ uri: rootUri, type: root.type, files: files.sort(compareDiscoveredFile), name: root.name, writable: true });
		} else if (root.type === DiscoveredType.Agent) {
			const files: IDiscoveredFile[] = [];
			// agents are markdown files directly under the root (no subdirectory scanning),
			// excluding only exact-case README.md.
			for (const child of children) {
				throwIfCancelled(token);

				if (child.isFile) {
					const filename = child.name;
					if (filename.endsWith(MARKDOWN_SUFFIX) && filename !== README_FILENAME && !seen.has(child.resource)) {
						seen.add(child.resource);
						files.push({ uri: child.resource, etag: child.etag });
					}
				}
			}
			result.push({ uri: rootUri, type: root.type, files: files.sort(compareDiscoveredFile), name: root.name, writable: true });

		} else if (root.type === DiscoveredType.Instruction) {
			const files: IDiscoveredFile[] = [];
			// instructions are all .instructions.md files directly under the root or in a subdirectory
			const findInstructions = async (stat: IFileStatWithMetadata, recursionLevel: number): Promise<void> => {
				throwIfCancelled(token);

				for (const child of stat.children ?? []) {
					throwIfCancelled(token);

					if (child.isFile) {
						const name = child.name.toLowerCase();
						if (name.endsWith(INSTRUCTION_FILE_SUFFIX) && !seen.has(child.resource)) {
							seen.add(child.resource);
							files.push({ uri: child.resource, etag: child.etag });
						}
					} else if (child.isDirectory && recursionLevel < MAX_INSTRUCTIONS_RECURSION_DEPTH) {
						let childStat: IFileStatWithMetadata | undefined = undefined;
						try {
							childStat = await this._fileService.resolve(child.resource, { resolveMetadata: true });
						} catch {
							// Ignore unreadable subdirectories.
						}
						if (childStat) {
							await findInstructions(childStat, recursionLevel + 1);
						}
					}
				}
			};
			if (stat) {
				await findInstructions(stat, 0);
			}
			result.push({ uri: rootUri, type: root.type, files: files.sort(compareDiscoveredFile), name: root.name, writable: true });
		} else if (root.type === DiscoveredType.Hook) {
			await this._scanForHooks(root, rootUri, stat, seen, result, token);
		} else {
			this._logService.warn(`[SessionCustomizationDiscovery] Unrecognized root type '${root.type}' for root '${rootUri.toString()}'`);
		}
	}

	private async _scanForHooks(root: ISearchRoot, rootUri: URI, stat: IFileStatWithMetadata | undefined, seen: ResourceSet, result: IDiscoveredDirectory[], token: CancellationToken): Promise<void> {
		const files: IDiscoveredFile[] = [];
		// hooks are recursively discovered as `*.json` under the root.
		const findHooks = async (directoryStat: IFileStatWithMetadata, recursionLevel: number): Promise<void> => {
			throwIfCancelled(token);

			for (const child of directoryStat.children ?? []) {
				throwIfCancelled(token);

				if (child.isFile) {
					const name = child.name.toLowerCase();
					if (name.endsWith(HOOK_FILE_SUFFIX) && !seen.has(child.resource)) {
						seen.add(child.resource);
						files.push({ uri: child.resource, etag: child.etag });
					}
				} else if (child.isDirectory && recursionLevel < MAX_HOOKS_RECURSION_DEPTH) {
					let childStat: IFileStatWithMetadata | undefined = undefined;
					try {
						childStat = await this._fileService.resolve(child.resource, { resolveMetadata: true });
					} catch {
						// Ignore unreadable subdirectories.
					}
					if (childStat) {
						await findHooks(childStat, recursionLevel + 1);
					}
				}
			}
		};
		if (stat) {
			await findHooks(stat, 0);
		}
		result.push({ uri: rootUri, type: root.type, files: files.sort(compareDiscoveredFile), name: root.name, writable: true });

	}
}

/**
 * Resolves `true` if a hook file (`*.json`) exists anywhere under
 * `<workingDirectory>/.github/hooks/`, else `false`; a missing directory is a
 * definitive `false`, but any other IO failure is rethrown so the caller can fail
 * open, and the optional {@link token} aborts the scan.
 */
export async function workspaceDirectoryHasHooks(fileService: IFileService, workingDirectory: URI, token: CancellationToken = CancellationToken.None): Promise<boolean> {
	// Linked to the caller's token so external cancellation aborts the scan, and
	// cancelled internally the moment a hook is found so the remaining parallel
	// branches stop launching further reads.
	const scanCts = new CancellationTokenSource(token);
	let found = false;
	const containsHook = async (directory: URI, depth: number): Promise<void> => {
		if (scanCts.token.isCancellationRequested) {
			return;
		}
		let stat: IFileStat;
		try {
			stat = await fileService.resolve(directory, { resolveMetadata: false });
		} catch (err) {
			// Ignore failures once we're winding down (a sibling already found a
			// hook, or the caller cancelled). Otherwise treat a missing directory
			// as "no hooks" and surface every other error so the caller fails open.
			if (!scanCts.token.isCancellationRequested && toFileOperationResult(err as Error) !== FileOperationResult.FILE_NOT_FOUND) {
				throw err;
			}
			return;
		}
		const children = stat.children ?? [];
		if (children.some(child => child.isFile && child.name.toLowerCase().endsWith(HOOK_FILE_SUFFIX))) {
			found = true;
			scanCts.cancel();
			return;
		}
		if (depth >= MAX_HOOKS_RECURSION_DEPTH) {
			return;
		}
		await Promise.all(children
			.filter(child => child.isDirectory)
			.map(child => containsHook(child.resource, depth + 1)));
	};
	try {
		await containsHook(joinPath(workingDirectory, '.github', 'hooks'), 0);
	} finally {
		// Cancel (not merely dispose) so that if a branch threw, sibling scans
		// still in flight wind down instead of leaking outstanding recursive IO
		// on the fail-open error path.
		scanCts.dispose(true);
	}
	// A caller-cancelled scan has an unreliable result; signal it rather than
	// reporting a (possibly premature) `false`.
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	return found;
}

// Test-only helpers — exported as `_internal` to discourage production use.
export const _internal = {
	AGENT_FILE_SUFFIX,
	INSTRUCTION_FILE_SUFFIX,
	SKILL_FILENAME,
	searchRoots,
	fixedDiscoveryFiles,
	agentInstructions,
};
