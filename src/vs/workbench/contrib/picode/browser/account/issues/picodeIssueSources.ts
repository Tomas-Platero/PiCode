/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the issue trackers answer, turned into one shape. Pure: no editor imports, so `node --test`
 * runs it directly (see `extensions/picode/test/picode-issue-sources.test.ts`).
 */

export type PicodeIssueSource = 'github' | 'jira';

export interface IPicodeIssue {
	readonly source: PicodeIssueSource;
	/** `owner/repo#12` or `PROJ-12`: the name a person would say. */
	readonly key: string;
	readonly title: string;
	readonly body: string;
	readonly url: string;
	/** The repository or the Jira project the issue belongs to. */
	readonly project: string;
	readonly author: string;
	/** True when the report came from somebody outside the team: its text is the least trustworthy. */
	readonly external: boolean;
	readonly updatedAt: string;
	readonly labels: readonly string[];
}

export interface IPicodeRepo {
	readonly owner: string;
	readonly repo: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** `https://github.com/o/r.git`, `git@github.com:o/r.git` and `ssh://git@github.com/o/r` all name `o/r`. */
export function parseGithubRemote(remote: string): IPicodeRepo | undefined {
	const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return match ? { owner: match[1], repo: match[2] } : undefined;
}

/** The address of the `origin` remote in the text of a `.git/config`. */
export function originFromGitConfig(config: string): string | undefined {
	let inOrigin = false;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('[')) {
			inOrigin = /^\[remote\s+"origin"\]$/.test(line);
		} else if (inOrigin) {
			const match = /^url\s*=\s*(.+)$/.exec(line);
			if (match) {
				return match[1].trim();
			}
		}
	}
	return undefined;
}

/** Who counts as inside the team. Everyone else wrote their report as an outsider. */
const GITHUB_INSIDERS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** GitHub's issue list also returns pull requests (they carry a `pull_request` key): those are dropped. */
export function mapGithubIssues(json: unknown, repo: IPicodeRepo): IPicodeIssue[] {
	if (!Array.isArray(json)) {
		return [];
	}
	const issues: IPicodeIssue[] = [];
	for (const item of json) {
		const issue = asRecord(item);
		if (!issue || 'pull_request' in issue) {
			continue;
		}
		const number = issue.number;
		const url = asString(issue.html_url);
		if (typeof number !== 'number' || !url.startsWith('https://')) {
			continue;
		}
		const labels = Array.isArray(issue.labels)
			? issue.labels.map(label => typeof label === 'string' ? label : asString(asRecord(label)?.name)).filter(name => name.length > 0)
			: [];
		issues.push({
			source: 'github',
			key: `${repo.owner}/${repo.repo}#${number}`,
			title: asString(issue.title),
			body: asString(issue.body),
			url,
			project: `${repo.owner}/${repo.repo}`,
			author: asString(asRecord(issue.user)?.login),
			external: !GITHUB_INSIDERS.has(asString(issue.author_association)),
			updatedAt: asString(issue.updated_at),
			labels,
		});
	}
	return issues;
}

/** The repositories the signed-in GitHub account lets PiCode read, from `GET /user/installations/{id}/repositories`. */
export function mapGithubRepos(json: unknown): IPicodeRepo[] {
	const list = asRecord(json)?.repositories;
	if (!Array.isArray(list)) {
		return [];
	}
	const repos: IPicodeRepo[] = [];
	for (const item of list) {
		const repo = asRecord(item);
		const owner = asString(asRecord(repo?.owner)?.login);
		const name = asString(repo?.name);
		if (owner && name && repo?.has_issues !== false) {
			repos.push({ owner, repo: name });
		}
	}
	return repos;
}

const MAX_ADF_DEPTH = 40;

/** Jira writes descriptions in Atlassian Document Format (a tree). This flattens it to plain text. */
export function adfToText(node: unknown, depth = 0): string {
	const current = asRecord(node);
	if (!current || depth > MAX_ADF_DEPTH) {
		return '';
	}
	const type = asString(current.type);
	if (type === 'text') {
		return asString(current.text);
	}
	if (type === 'hardBreak') {
		return '\n';
	}
	if (type === 'mention') {
		return asString(asRecord(current.attrs)?.text);
	}
	const children = Array.isArray(current.content) ? current.content.map(child => adfToText(child, depth + 1)).join('') : '';
	if (type === 'listItem') {
		return `- ${children.trim()}\n`;
	}
	return ['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(type) ? `${children}\n` : children;
}

/** `GET /search/jql` answer → issues. `siteUrl` is the site the user sees, e.g. `https://acme.atlassian.net`. */
export function mapJiraIssues(json: unknown, siteUrl: string): IPicodeIssue[] {
	const list = asRecord(json)?.issues;
	if (!Array.isArray(list) || !/^https:\/\/[A-Za-z0-9.-]+$/.test(siteUrl)) {
		return [];
	}
	const issues: IPicodeIssue[] = [];
	for (const item of list) {
		const issue = asRecord(item);
		const key = asString(issue?.key);
		const fields = asRecord(issue?.fields);
		if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !fields) {
			continue;
		}
		const reporter = asRecord(fields.reporter);
		issues.push({
			source: 'jira',
			key,
			title: asString(fields.summary),
			body: adfToText(fields.description).trim(),
			url: `${siteUrl}/browse/${key}`,
			project: asString(asRecord(fields.project)?.key) || key.split('-')[0],
			author: asString(reporter?.displayName),
			// People of the site are `atlassian` accounts; `customer` accounts are the public who use a help portal.
			external: asString(reporter?.accountType) !== 'atlassian',
			updatedAt: asString(fields.updated),
			labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === 'string') : [],
		});
	}
	return issues;
}

/**
 * A title that starts with a bracketed tag (`[recruiting]: Open the call`) split in two, so the
 * list can show the tag as a label and give the whole line to what the issue says. A title that
 * is only a tag, or whose tag is long, is left as it is.
 */
export function splitTitleTag(title: string): { readonly tag: string | undefined; readonly text: string } {
	const match = /^\[([^\]]{1,24})\]\s*:?\s*(\S[\s\S]*)$/.exec(title.trim());
	return match ? { tag: match[1].trim(), text: match[2].trim() } : { tag: undefined, text: title };
}
