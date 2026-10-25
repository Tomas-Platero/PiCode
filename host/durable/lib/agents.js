// Agents wiring: reads the pi profile's agents/ folder (READ-ONLY).
//
// Expected shape (from the pi agent convention): agents/<name>.md with YAML-ish
// frontmatter (`name`, `description`) and a body that is the agent's
// instructions. The folder is OPTIONAL: as of this writing the owner's profile
// has no agents/ folder, so loadAgents() returns [] and `--agent` fails with a
// clear message. When the folder appears, no code change is needed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./skills.js";

export function agentsDir(profileDir) {
	return join(profileDir, "agents");
}

/** Read the profile's agents/*.md files: [{ name, description, instructions }]. */
export function loadAgents(profileDir) {
	const root = agentsDir(profileDir);
	if (!existsSync(root)) return [];
	const agents = [];
	for (const dirent of readdirSync(root, { withFileTypes: true })) {
		if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith(".md")) continue;
		const { frontmatter, body } = parseFrontmatter(readFileSync(join(root, dirent.name), "utf8"));
		agents.push({
			name: frontmatter.name || dirent.name.replace(/\.md$/i, ""),
			description: frontmatter.description || "",
			instructions: body,
		});
	}
	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `--agent <name>` / `agent` request parameter → the configure change that
 * makes a conversation run with that agent's instructions. Fails with a clear
 * message (and the available names) when the agent does not exist.
 */
export function resolveAgentChange(agents, agentName, profileDir) {
	if (!agentName) return undefined;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const known = agents.map((a) => a.name).join(", ") || "(none)";
		throw new Error(`No agent "${agentName}" in ${agentsDir(profileDir)}. Available: ${known}`);
	}
	console.error(`[agent] ${agent.name}${agent.description ? ` — ${agent.description.slice(0, 120)}` : ""}`);
	return { instructions: agent.instructions };
}
