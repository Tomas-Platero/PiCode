// Deterministic destructive-command guard, as an extension hook on the built-in
// ToolTask. It blocks in CODE — the model is never asked, and cannot argue its
// way past it. A blocked call returns `{ block: "<reason>" }` so the model sees
// why and the block lands in the transcript as an error tool result.
//
// Per-conversation opt-in: the extension owns a conversation document
// (app.guard) holding `allow`: a list of exact command strings the user added
// with `node cli.js allow <conversationId> "<command>"`. A blocked command
// whose normalized text is on that list is allowed through.
import path from "node:path";
import { defineDoc, defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";

/** Per-conversation guard state: exact command strings the user explicitly allowed. */
export const GuardDoc = defineDoc({
	kind: "app.guard",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current", // a fork starts with its parent's allow list
	initial: () => ({ allow: [] }),
});

/** Whitespace-normalized form used both for the allow list and for matching. */
export function normalizeCommand(command) {
	return String(command ?? "").replace(/\s+/g, " ").trim();
}

/** The working directory this process guards. Absolute writes outside it are blocked. */
export function workDir() {
	return process.cwd();
}

// --- destructive bash command patterns -----------------------------------------

function rmFlags(command) {
	const words = command.split(/\s+/).filter(Boolean);
	const idx = words.findIndex((w) => w === "rm" || w.endsWith("/rm") || w.endsWith("\\rm"));
	if (idx !== 0 && idx !== 1) return []; // rm not the command (allow one env-assignment prefix)
	return words.slice(idx + 1).filter((w) => /^-{1,2}[A-Za-z-]/.test(w) && w !== "--");
}

function isRecursiveRm(command) {
	const flags = rmFlags(command);
	return flags.some((f) => {
		const name = f.replace(/^-{1,2}/, "");
		if (f.startsWith("--")) return name === "recursive";
		return name.includes("r") || name.includes("R");
	});
}

const BASH_RULES = [
	{
		test: (c) => /\brm\b|\b\/rm\b/.test(c) && isRecursiveRm(c),
		reason: "recursive `rm` (rm -r / -rf / --recursive) deletes whole trees",
	},
	{
		test: (c) => /\bgit\s+push\b[^|;&]*\s(?:--force\b|--force-with-lease\b|-f\b)/.test(c),
		reason: "`git push --force` rewrites shared history",
	},
	{
		test: (c) => /\bgit\s+reset\b[^|;&]*--hard\b/.test(c),
		reason: "`git reset --hard` discards uncommitted work",
	},
	{
		test: (c) => /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/.test(c),
		reason: "`git clean -f` force-deletes untracked files",
	},
	{
		test: (c) => /(?:^|[;&|]\s*)format\b/i.test(c),
		reason: "`format` wipes a disk volume",
	},
	{
		test: (c) => /\bdel\b(?=[^|;&]*\/f)(?=[^|;&]*\/s)/i.test(c) || /\bdel\b(?=[^|;&]*\/s)(?=[^|;&]*\/f)/i.test(c),
		reason: "`del /f /s` force-deletes recursively",
	},
	{
		test: (c) => /\b(?:rd|rmdir)\b[^|;&]*\/s\b/i.test(c),
		reason: "`rd /s` deletes a directory tree",
	},
	{
		test: (c) => /\bremove-item\b(?=[^|;&]*-recurse)(?=[^|;&]*-force)/i.test(c) || /\bremove-item\b(?=[^|;&]*-force)(?=[^|;&]*-recurse)/i.test(c),
		reason: "`Remove-Item -Recurse -Force` deletes whole trees",
	},
	{
		test: (c) => /\bmkfs(?:\.\w+)?\b/.test(c),
		reason: "`mkfs` creates a new filesystem, wiping the volume",
	},
	{
		test: (c) => /\bdd\b[^|;&]*\bof=\/dev\//.test(c),
		reason: "`dd of=/dev/...` overwrites a raw device",
	},
	{
		test: (c) => /\bdiskpart\b/i.test(c),
		reason: "`diskpart` repartitions disks",
	},
];

/** Reason a bash command is destructive, or undefined when it passes. */
export function destructiveBashReason(command) {
	const c = normalizeCommand(command);
	for (const rule of BASH_RULES) {
		if (rule.test(c)) return rule.reason;
	}
	return undefined;
}

// --- writes outside the working directory --------------------------------------

function isAbsolutePath(p) {
	return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/** Absolute redirection/tee targets in a bash command that land outside the working directory. */
function bashWritesOutsideWorkdir(command) {
	const c = normalizeCommand(command);
	const targets = [];
	// redirections: > path, >> path, n> path, n>> path, &> path
	for (const m of c.matchAll(/(?:^|\s)\d?&?>{1,2}\s*(\S+)/g)) targets.push(m[1]);
	// tee <path>
	for (const m of c.matchAll(/\btee\s+(?:-{1,2}[\w-]+\s+)*(\S+)/g)) targets.push(m[1]);
	const base = path.resolve(workDir());
	for (const t of targets) {
		const cleaned = t.replace(/^["']|["']$/g, "");
		if (!isAbsolutePath(cleaned)) continue;
		const resolved = path.resolve(cleaned);
		if (resolved !== base && !resolved.startsWith(base + path.sep)) return resolved;
	}
	return undefined;
}

/**
 * Reason a tool call is blocked, or undefined when it passes.
 * `call` is the pi-ai ToolCall: { name, arguments }.
 */
export function guardReason(call) {
	const name = String(call?.name ?? "");
	const args = call?.arguments ?? {};
	if (name === "bash") {
		const command = String(args.command ?? "");
		const destructive = destructiveBashReason(command);
		if (destructive) return { kind: "destructive", reason: destructive, command };
		const outside = bashWritesOutsideWorkdir(command);
		if (outside) return { kind: "outside", reason: `writes outside the working directory (${outside})`, command };
	}
	if (name === "write" || name === "edit") {
		const p = String(args.path ?? "");
		if (p) {
			const resolved = path.resolve(p); // relative paths resolve against the working directory
			const base = path.resolve(workDir());
			if (resolved !== base && !resolved.startsWith(base + path.sep)) {
				return { kind: "outside", reason: `writes outside the working directory (${resolved})`, command: p };
			}
		}
	}
	return undefined;
}

/**
 * The guard extension. Installed by the CLI (not by the proofs, whose transcript
 * expectations are frozen); every conversation it is selected for gets the hook.
 *
 * `enabled: false` is the `--no-guard` / `picode.durable.guard: false` switch, and
 * off means off: no hook is installed at all, so nothing can block a tool call.
 * (It does not merely silence the prompt section — a hook without a section would
 * still block, which would make the setting a lie.)
 */
export function makeGuardExtension({ enabled = true } = {}) {
	const guardSection = section(
		"guard",
		() =>
			enabled
				? "A deterministic guard blocks destructive commands (recursive deletes, forced pushes/history rewrites, disk operations) and any write outside the working directory, before the tool runs. A blocked call returns an error explaining why. The user can explicitly allow an exact command for this conversation; if a blocked command is genuinely needed, ask the user to allow it — do not try variants to sneak past the guard."
				: undefined,
	);

	return defineExtension({
		name: "guard",
		sections: [guardSection],
		hooks: enabled
			? [
					hook(ToolTask, {
						beforeTool: async (call, api, context) => {
							const verdict = guardReason(call);
							if (!verdict) return undefined;
							// Explicit per-conversation opt-in: exact command on the allow list.
							const doc = await api.snapshot(GuardDoc, api.conversationId, context);
							const normalized = normalizeCommand(verdict.command);
							if (doc?.allow?.some((a) => normalizeCommand(a) === normalized)) {
								return undefined; // explicitly allowed by the user: pass through
							}
							const why = `Blocked by the deterministic guard: ${verdict.reason}.`;
							return {
								block: `${why} The user can allow this exact command for this conversation with: node cli.js allow <conversationId> "${normalized}"`,
							};
						},
					}),
				]
			: [],
	});
}
