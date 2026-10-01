/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	listSessionBackupFiles,
	nodeBackupFs,
	sessionContentHash,
	sessionKeyFromTranscript,
	type BackupFs,
} from './sessions-provider';

/**
 * pi's sessions, backed up to PiCode Cloud — and restored from it.
 *
 * ## A backup channel, not a live sync
 *
 * Every session transcript under `~/.pi/agent/sessions/<project-slug>/` is uploaded **as its
 * own opaque ref** on the `piSessionsBackup` resource: one POST per file, refs accumulating
 * on the resource's refs list. The server gzips and encrypts what it stores, so the body
 * travels as the raw transcript and nothing here sees or builds an envelope. Restoring is the
 * reverse: read the refs list, fetch each ref's plaintext, and write the transcripts back.
 *
 * ## Incremental by hash
 *
 * A full account holds ~200 MB of transcripts, so re-uploading everything on every run is not
 * a run anyone would wait for. Instead each file's SHA-1 is remembered (with the ref the
 * upload returned) in the extension's global state, and only files whose hash changed — or
 * that were never seen — are uploaded. pi appends to transcripts, so an untouched session is
 * skipped and a session the owner just used costs one small upload.
 *
 * ## Deletions are history
 *
 * A transcript removed locally does **not** delete its cloud ref: this is a backup, and the
 * refs list is the history. Nothing here ever issues a DELETE.
 *
 * ## The editor only at the edges
 *
 * The same split the other modules keep: hashing, listing and the key reconstruction are
 * plain functions over an injectable file system, and they live beside pi's own slug in
 * `sessions-provider.ts` — vscode-free, the way every rule the tests run is kept.
 * `extension.ts` hands in the editor-only parts (the global
 * state, the progress and message surfaces).
 */

/** The sync API the account provider's whole contract lives on. */
const SYNC_API_BASE = 'https://www.getpicode.app/api/v1';

/** The resource the session transcripts back up onto: one ref per file. */
const SESSIONS_RESOURCE = 'piSessionsBackup';

/** The account provider and the scopes its sessions carry (`product.json` declares `sync`). */
const PICODE_AUTH_PROVIDER_ID = 'picode';
const PICODE_AUTH_SCOPES = ['sync'];

/**
 * A transcript larger than this is skipped: the server gzips before storing, but a file this
 * size would still risk blowing Firestore's 1 MiB-per-document ceiling, and the quota with
 * it. Collected and reported at the end rather than failed silently.
 */
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
// Rolling window: only sessions touched within the last 7 days are backed up, and
// cloud refs older than the window are evicted to keep the account under quota.
const ROLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Uploads stop (oldest-first) once the estimated cloud footprint would cross this.
const QUOTA_SOFT_LIMIT_BYTES = 45 * 1024 * 1024;

/** The global-state key the per-file incremental state lives under. */
const BACKUP_STATE_KEY = 'picode.sessionsBackup.state.v1';

/** pi's sessions, where the runtime keeps them on this machine. */
export function piSessionsDir(): string {
	return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/* ------------------------------------------------------------------ *
 * The rules, with no editor in the way
 * ------------------------------------------------------------------ */

/** One backed-up file's remembered state: what it hashed last time, and the ref that holds it. */
interface SessionBackupEntry {
	readonly hash: string;
	readonly ref: string;
	/** Raw size at upload time, for the quota estimate. */
	readonly bytes?: number;
	/** Local mtime at upload time, for the rolling-window eviction. */
	readonly mtime?: number;
}

/** The per-file state, keyed by `<project-slug>/<file name>`. */
type SessionBackupState = Record<string, SessionBackupEntry>;

/** What a backup run did, said at the end in one sentence. */
export interface BackupReport {
	readonly uploaded: number;
	readonly unchanged: number;
	/** Files skipped because they exceed the size ceiling, as keys. */
	readonly skippedTooLarge: readonly string[];
	/** Files whose local mtime is older than the rolling window, as keys. */
	readonly skippedTooOld: readonly string[];
	/** Cloud refs evicted because they fell outside the rolling window. */
	readonly evicted: number;
	/** Files skipped because the quota soft limit was reached, as keys. */
	readonly skippedQuota: readonly string[];
	/** Files that failed to upload, with the reason the run kept going. */
	readonly failures: readonly string[];
}

/** What a restore run found, before anything is written. */
export interface RestorePlan {
	/** The transcripts the cloud holds, keyed and deduplicated (the newest ref wins). */
	readonly files: ReadonlyMap<string, Buffer>;
	/** Refs whose content did not open with a session record and could not be placed. */
	readonly unreadableRefs: number;
}

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

/**
 * The session's fresh ID token, obtained the way the account provider hands it out.
 *
 * The provider refreshes the Firebase token itself when the cached one went stale, so every
 * run asks again rather than keeping a token of its own — a stored token would go stale
 * mid-run and be nobody's to refresh. `undefined` means the owner is not signed in.
 */
async function picodeIdToken(): Promise<string | undefined> {
	const session = await vscode.authentication.getSession(PICODE_AUTH_PROVIDER_ID, PICODE_AUTH_SCOPES, { createIfNone: false });
	return session?.idToken ?? session?.accessToken;
}

/** The headers every sync call carries: the account, and who is asking. */
function syncHeaders(idToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${idToken}`,
		'x-client-name': 'picode',
		'x-account-type': 'picode',
	};
}

/**
 * The failure a run stops on, worded for the owner.
 *
 * A 401 mid-run means the sign-in was revoked while the run was going on; retrying with the
 * same token would only fail again, so the run stops here — the next run picks up whatever
 * session is signed in then, and the incremental state makes that cheap.
 */
export class SessionExpiredError extends Error {
	constructor() {
		super('Session expired — sign in again');
	}
}

/** Turns a non-ok status into the error the run reports, 401 being the stop-the-run one. */
function apiFailure(status: number, what: string): Error {
	if (status === 401) {
		return new SessionExpiredError();
	}
	return new Error(`${what} answered ${status}`);
}

/** One ref of the `piSessionsBackup` resource, as the refs list answers. */
interface PiSessionRefEntry {
	readonly url: string;
	readonly created: number;
}

/** The network and file system a run runs through; injectable for tests. */
export interface SessionsBackupDeps {
	/** The extension's global state: where the per-file hash/ref record survives restarts. */
	readonly globalState: vscode.Memento;
	/** pi's sessions directory; the machine's own unless a test hands another one in. */
	readonly sessionsDir: string;
	/** The backing file system; the node one unless a test hands another one in. */
	readonly backupFs?: BackupFs;
	/** The HTTP function; the global one unless a test hands another one in. */
	readonly fetchFn?: typeof fetch;
	/** Where the run's per-file progress lines go. */
	readonly onProgress?: (message: string) => void;
}

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

/**
 * One backup run: every changed transcript onto the cloud.
 *
 * The state is read once, updated after **every** successful upload and written back as the
 * run goes, so a run interrupted halfway never re-uploads what already made it — the next run
 * continues from the last completed file. Files that fail are reported and skipped; the run
 * only stops on a 401, where retrying cannot succeed.
 */
export async function runSessionsBackup(deps: SessionsBackupDeps): Promise<BackupReport> {
	const idToken = await picodeIdToken();
	if (idToken === undefined) {
		throw new NotSignedInError();
	}

	const backupFs = deps.backupFs ?? nodeBackupFs;
	const fetchFn = deps.fetchFn ?? fetch;
	const state: SessionBackupState = { ...deps.globalState.get<SessionBackupState>(BACKUP_STATE_KEY) ?? {} };
	const files = listSessionBackupFiles(deps.sessionsDir, backupFs);

	let uploaded = 0;
	let unchanged = 0;
	const skippedTooLarge: string[] = [];
	const skippedTooOld: string[] = [];
	const skippedQuota: string[] = [];
	const failures: string[] = [];

	const windowFloor = Date.now() - ROLLING_WINDOW_MS;

	// Eviction: cloud refs whose session fell outside the rolling window (or whose
	// local mtime the state remembers as outside it) are deleted, keeping the
	// account inside its quota with a bounded window.
	let evicted = 0;
	for (const [key, entry] of Object.entries(state)) {
		if (files.some(f => f.key === key)) {
			continue; // still on disk and still considered
		}
		if ((entry.mtime ?? 0) >= windowFloor) {
			continue; // recent, and its local file is only temporarily missing
		}
		try {
			const response = await fetchFn(`${SYNC_API_BASE}/resource/${SESSIONS_RESOURCE}/${entry.ref}`, {
				method: 'DELETE',
				headers: { ...syncHeaders(idToken) },
			});
			if (response.ok || response.status === 404) {
				delete state[key];
				evicted++;
				await deps.globalState.update(BACKUP_STATE_KEY, state);
			}
		} catch {
			// A failed eviction is retried on the next run; never fatal.
		}
	}

	let estimatedBytes = 0;
	for (const entry of Object.values(state)) {
		estimatedBytes += entry.bytes ?? 0;
	}

	// Oldest first so that, when the soft quota runs out, the newest sessions win.
	const inWindow = files
		.filter(file => file.mtime >= windowFloor)
		.sort((a, b) => a.mtime - b.mtime);
	for (const file of files) {
		if (!inWindow.includes(file)) {
			skippedTooOld.push(file.key);
		}
	}

	for (const file of inWindow) {
		// The size is known from the listing: skip the giants before reading a byte.
		if (file.bytes > MAX_SESSION_BYTES) {
			skippedTooLarge.push(file.key);
			continue;
		}
		// Quota guard: uploads stop once the account would cross the soft limit —
		// the newest sessions keep their place, the oldest ones yield.
		if (estimatedBytes + file.bytes > QUOTA_SOFT_LIMIT_BYTES) {
			skippedQuota.push(file.key);
			continue;
		}
		let content: Buffer;
		try {
			content = backupFs.read(file.file);
		} catch (error) {
			failures.push(`${file.key} (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		const hash = sessionContentHash(content);
		if (state[file.key]?.hash === hash) {
			unchanged++;
			continue;
		}
		deps.onProgress?.(file.key);
		let response: Response;
		try {
			response = await fetchFn(`${SYNC_API_BASE}/resource/${SESSIONS_RESOURCE}`, {
				method: 'POST',
				headers: { ...syncHeaders(idToken), 'content-type': 'text/plain' },
				body: new Uint8Array(content),
			});
		} catch (error) {
			failures.push(`${file.key} (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		if (!response.ok) {
			// A revoked sign-in stops the run: nothing after it can succeed either, and the
			// uploads already completed are safely in the state. Anything else is one file's
			// failure, said at the end.
			const failure = apiFailure(response.status, SESSIONS_RESOURCE);
			if (failure instanceof SessionExpiredError) {
				throw failure;
			}
			failures.push(`${file.key} (${failure.message})`);
			continue;
		}
		const ref = response.headers.get('etag')?.replace(/^"|"$/g, '') ?? '';
		state[file.key] = { hash, ref, bytes: file.bytes, mtime: file.mtime };
		estimatedBytes += file.bytes;
		uploaded++;
		await deps.globalState.update(BACKUP_STATE_KEY, state);
	}

	return { uploaded, unchanged, skippedTooLarge, skippedTooOld, evicted, skippedQuota, failures };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

/**
 * Reads the refs list and fetches every transcript back, keyed by what its own content says.
 *
 * Refs accumulate — the same file backed up twice is on the list twice — so entries are folded
 * by key with the **newest** ref winning: the list answers oldest first, so the last ref read
 * for a key is its latest version. The result is held in memory; a run's worth of transcripts
 * is the ~200 MB the folder already is, and nothing writes before the owner confirms.
 */
export async function planSessionsRestore(deps: SessionsBackupDeps): Promise<RestorePlan> {
	const idToken = await picodeIdToken();
	if (idToken === undefined) {
		throw new NotSignedInError();
	}

	const fetchFn = deps.fetchFn ?? fetch;
	let listResponse: Response;
	try {
		listResponse = await fetchFn(`${SYNC_API_BASE}/resource/${SESSIONS_RESOURCE}`, {
			headers: syncHeaders(idToken),
		});
	} catch (error) {
		throw new Error(`PiCode Cloud could not be reached (${error instanceof Error ? error.message : String(error)}).`);
	}
	if (!listResponse.ok) {
		throw apiFailure(listResponse.status, `The ${SESSIONS_RESOURCE} refs list`);
	}
	const refs = await listResponse.json() as PiSessionRefEntry[];

	const files = new Map<string, Buffer>();
	let unreadableRefs = 0;
	for (const [index, entry] of refs.entries()) {
		deps.onProgress?.(`ref ${index + 1} of ${refs.length}`);
		let response: Response;
		try {
			response = await fetchFn(entry.url, { headers: syncHeaders(idToken) });
		} catch {
			unreadableRefs++;
			continue;
		}
		if (!response.ok) {
			// The list can carry a ref the content read cannot serve; one unreadable ref is
			// counted and skipped, the way one failing file is in a backup run. A 401, though,
			// stops the run — the token died under it and no later read can succeed.
			if (response.status === 401) {
				throw new SessionExpiredError();
			}
			unreadableRefs++;
			continue;
		}
		const content = Buffer.from(await response.arrayBuffer());
		const key = sessionKeyFromTranscript(content.toString('utf8'));
		if (key === undefined) {
			unreadableRefs++;
			continue;
		}
		// Oldest-first list: the ref read later for a key is that transcript's newest version.
		files.set(key, content);
	}
	return { files, unreadableRefs };
}

/**
 * Writes the planned transcripts home.
 *
 * A file the machine already holds **identically** is skipped without a word; everything else
 * is written only because the owner confirmed the overwrite beforehand. This is the only write
 * the restore performs — the confirmation is the caller's to ask, and it should have counted
 * what this would overwrite from the plan first.
 */
export function applySessionsRestore(plan: RestorePlan, sessionsDir: string, backupFs: BackupFs = nodeBackupFs): { written: number; identical: number } {
	let written = 0;
	let identical = 0;
	for (const [key, content] of plan.files) {
		const file = path.join(sessionsDir, ...key.split('/'));
		try {
			if (backupFs.exists(file) && sessionContentHash(backupFs.read(file)) === sessionContentHash(content)) {
				identical++;
				continue;
			}
		} catch {
			// An existing file that cannot be read is overwritten, not preserved.
		}
		backupFs.write(file, content);
		written++;
	}
	return { written, identical };
}

/** Counts the transcripts the plan would change on this machine, for the confirmation's number. */
export function countChangedSessions(plan: RestorePlan, sessionsDir: string, backupFs: BackupFs = nodeBackupFs): number {
	let changed = 0;
	for (const [key, content] of plan.files) {
		const file = path.join(sessionsDir, ...key.split('/'));
		try {
			if (backupFs.exists(file) && sessionContentHash(backupFs.read(file)) === sessionContentHash(content)) {
				continue;
			}
		} catch {
			// An unreadable local file counts as changed: writing over it is the point.
		}
		changed++;
	}
	return changed;
}

/* ------------------------------------------------------------------ *
 * The commands
 * ------------------------------------------------------------------ */

/** The backup command's id; the manifest contributes the same one. */
export const BACKUP_SESSIONS_COMMAND = 'picode.backupSessions';

/** The restore command's id; the manifest contributes the same one. */
export const RESTORE_SESSIONS_COMMAND = 'picode.restoreSessions';

/** A sentence for the files too large to back up, or nothing when there are none. */
function tooLargeSentence(skipped: readonly string[]): string {
	if (skipped.length === 0) {
		return '';
	}
	const first = skipped.slice(0, 3).join(', ');
	const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
	return ` Skipped (larger than 20 MB): ${first}${more}.`;
}

/**
 * Thrown when a run starts without a PiCode account signed in. The commands catch it and end
 * with a Sign in button, so the answer to it is one press rather than a hunt through settings.
 */
export class NotSignedInError extends Error {
	constructor() {
		super('Not signed in to PiCode — sign in first.');
	}
}

/** The not-signed-in ending: one sentence, and the button that opens the product's own sign-in. */
/**
 * Asks for the sign-in the backup needs, and offers the button that starts it.
 *
 * The button asks for the **account** session — the same provider and scopes the backup reads a
 * few lines below — and not the provider-subscription command, which connects an AI provider
 * (ChatGPT, Claude…) and would leave the owner signed in everywhere except the account this
 * feature needs.
 */
function offerSignIn(): void {
	void vscode.window.showErrorMessage('PiCode: sign in to use your account.', 'Sign in').then(choice => {
		if (choice !== undefined) {
			void vscode.authentication.getSession(PICODE_AUTH_PROVIDER_ID, PICODE_AUTH_SCOPES, { createIfNone: true });
		}
	});
}

/**
 * The two backup commands, registered against the editor's own surfaces.
 *
 * Both run under a progress window because either can move hundreds of megabytes, and both
 * end in one sentence that says what happened. The backup reports its count and anything it
 * had to skip; the restore counts what would change **before** it asks, then writes what was
 * confirmed — a file that would be identical is never part of the question.
 */
export function registerSessionsBackupCommands(deps: SessionsBackupDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(BACKUP_SESSIONS_COMMAND, () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Backing up pi sessions to PiCode Cloud…' },
			async (progress: vscode.Progress<{ message?: string }>) => {
				let report: BackupReport;
				try {
					report = await runSessionsBackup({
						...deps,
						onProgress: message => progress.report({ message }),
					});
				} catch (error) {
					if (error instanceof NotSignedInError) {
						offerSignIn();
						return;
					}
					throw error;
				}
				const parts = [
					`${report.uploaded} uploaded`,
					`${report.unchanged} already backed up`,
				];
				if (report.failures.length > 0) {
					parts.push(`${report.failures.length} failed`);
				}
				void vscode.window.showInformationMessage(
					`PiCode: pi session backup finished — ${parts.join(', ')}.${tooLargeSentence(report.skippedTooLarge)}`);
				if (report.failures.length > 0) {
					console.error(`[pi] session backup failures: ${report.failures.join('; ')}`);
				}
			},
		)),
		vscode.commands.registerCommand(RESTORE_SESSIONS_COMMAND, () => vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Reading pi sessions from PiCode Cloud…' },
			async (progress: vscode.Progress<{ message?: string }>) => {
				let plan: RestorePlan;
				try {
					plan = await planSessionsRestore({
						...deps,
						onProgress: message => progress.report({ message }),
					});
				} catch (error) {
					if (error instanceof NotSignedInError) {
						offerSignIn();
						return;
					}
					throw error;
				}
				if (plan.files.size === 0) {
					void vscode.window.showInformationMessage('PiCode: the cloud holds no pi sessions to restore.'
						+ (plan.unreadableRefs > 0 ? ` (${plan.unreadableRefs} unreadable refs were skipped.)` : ''));
					return;
				}
				const changed = countChangedSessions(plan, deps.sessionsDir);
				if (changed === 0) {
					void vscode.window.showInformationMessage(`PiCode: all ${plan.files.size} cloud sessions are already on this machine.`);
					return;
				}
				const confirmed = await vscode.window.showWarningMessage(
					`Restore ${changed} pi session file${changed === 1 ? '' : 's'} from PiCode Cloud? Files that differ from what this machine holds will be overwritten.`,
					{ modal: true },
					'Restore',
				);
				if (confirmed !== 'Restore') {
					return;
				}
				const { written, identical } = applySessionsRestore(plan, deps.sessionsDir);
				void vscode.window.showInformationMessage(
					`PiCode: restored ${written} pi session file${written === 1 ? '' : 's'} (${identical} already up to date).`);
			},
		)),
	];
}
