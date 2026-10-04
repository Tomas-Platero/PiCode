// Skills wiring: reads the pi profile's skills/ tree (READ-ONLY) and exposes it
// to the model as (a) a system-prompt index section and (b) a load_skill tool
// that returns one skill's full SKILL.md body.
//
// Profile shape (observed): skills/<dir-name>/SKILL.md, with YAML-ish
// frontmatter carrying `name` and `description` (and optional `metadata`);
// some skills also ship reference/ or evals/ folders that are NOT loaded —
// only SKILL.md is surfaced, with its path in the index.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

/** Minimal frontmatter parser for `key: value` lines between --- markers. */
export function parseFrontmatter(text) {
	const result = {};
	if (!text.startsWith("---")) return { frontmatter: result, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: result, body: text };
	for (const line of text.slice(3, end).split(/\r?\n/)) {
		const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		if (m && m[2] !== "") result[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	const after = text.indexOf("\n", end + 1);
	return { frontmatter: result, body: after === -1 ? "" : text.slice(after + 1).trim() };
}

/** Read the profile's skills/ tree: one entry per directory holding a SKILL.md. */
export function loadSkills(profileDir) {
	const root = join(profileDir, "skills");
	if (!existsSync(root)) return [];
	const skills = [];
	for (const dirent of readdirSync(root, { withFileTypes: true })) {
		if (!dirent.isDirectory()) continue;
		const skillPath = join(root, dirent.name, "SKILL.md");
		if (!existsSync(skillPath) || !statSync(skillPath).isFile()) continue;
		const { frontmatter, body } = parseFrontmatter(readFileSync(skillPath, "utf8"));
		skills.push({
			name: frontmatter.name || dirent.name,
			description: frontmatter.description || "",
			path: skillPath,
			body,
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extension exposing the skills. The index section is rendered from the list
 * captured at startup, so it is deterministic within a process and keeps the
 * provider prompt cache warm. An empty list omits the section entirely.
 */
export function makeSkillsExtension(skills) {
	const index = skills.length
		? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
		: undefined;

	const loadSkill = defineTool({
		name: "load_skill",
		description:
			"Load one skill's full instructions by name. Use the names listed in the <skills> section of the system prompt.",
		parameters: Type.Object({ name: Type.String({ description: "the skill's name from the skills index" }) }),
		execute: async (args) => {
			const skill = skills.find((s) => s.name === args.name);
			if (!skill) {
				return {
					content: [{ type: "text", text: `Unknown skill "${args.name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}.` }],
				};
			}
			return { content: [{ type: "text", text: skill.body || "(empty skill file)" }] };
		},
	});

	return defineExtension({
		name: "profile-skills",
		sections: [section("skills", () => index)],
		tools: [loadSkill],
	});
}
