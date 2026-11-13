/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/picodeProvidersModels.css';
import { $, addDisposableListener } from '../../../../base/browser/dom.js';

/**
 * The little mark that identifies a provider, in three steps down.
 *
 * 1. **A known domain** for the services people actually use, so the mark is the real one.
 * 2. **The provider's own address**, when it declares one: a favicon served by DuckDuckGo's icon
 *    endpoint, which needs no key and no bundling.
 * 3. **Initials on a colour derived from the name**, when neither is available — an avatar is still
 *    an identity, and a broken image is not.
 *
 * Why not `simple-icons`: it is a Node package with thousands of brands, and this panel needs a
 * handful. Loading it into the workbench bundle to draw nine icons is the kind of dependency that
 * costs more than it explains. The favicon route gives the same result without shipping a catalogue
 * this product would have to keep in step.
 */

/** Domains for the services whose mark is worth recognising at a glance. */
const KNOWN_DOMAINS: Readonly<Record<string, string>> = {
	openai: 'openai.com',
	'openai-codex': 'openai.com',
	anthropic: 'anthropic.com',
	claude: 'anthropic.com',
	deepseek: 'deepseek.com',
	groq: 'groq.com',
	ollama: 'ollama.com',
	openrouter: 'openrouter.ai',
	google: 'gemini.google.com',
	gemini: 'gemini.google.com',
	xai: 'x.ai',
	mistral: 'mistral.ai',
	meta: 'meta.com',
	kimi: 'moonshot.ai',
	'kimi-coding': 'moonshot.ai',
	github: 'github.com',
	'github-copilot': 'github.com',
	radius: 'radius.dev',
	'amazon-bedrock': 'aws.amazon.com',
	azure: 'azure.microsoft.com',
	baseten: 'baseten.co',
	cerebras: 'cerebras.ai',
	fireworks: 'fireworks.ai',
	'google-vertex': 'cloud.google.com',
	huggingface: 'huggingface.co',
	minimax: 'minimax.io',
	moonshotai: 'moonshot.ai',
	nvidia: 'nvidia.com',
	opencode: 'opencode.ai',
	together: 'together.ai',
	'vercel-ai-gateway': 'vercel.com',
	xiaomi: 'mi.com',
	zai: 'z.ai',
	qwen: 'qwen.ai',
	// MCP servers people commonly connect.
	aikido: 'aikido.dev',
	atlassian: 'atlassian.com',
	'atlassian-rovo-mcp': 'atlassian.com',
	firebase: 'firebase.google.com',
	sentry: 'sentry.io',
	supabase: 'supabase.com',
	'supabase-mcp-server': 'supabase.com',
	vercel: 'vercel.com',
	linear: 'linear.app',
	notion: 'notion.so',
	slack: 'slack.com',
	stripe: 'stripe.com',
	figma: 'figma.com',
	cloudflare: 'cloudflare.com',
	context7: 'context7.com',
	playwright: 'playwright.dev',
	repomix: 'repomix.com',
	codegraph: 'github.com',
	'sequential-thinking': 'modelcontextprotocol.io',
};

/**
 * Domains whose mark is dark ink on a transparent background, so it disappears on a dark theme
 * (measured on the icons these domains serve: every other mark here carries its own colour or
 * background and stays readable). Dark themes draw these inverted, i.e. white.
 */
const DARK_INK_DOMAINS: ReadonlySet<string> = new Set(['github.com', 'radius.dev']);

/** Properly written names for the services whose spelling is not just the id capitalised. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	'atlassian-rovo-mcp': 'Atlassian Rovo',
	'supabase-mcp-server': 'Supabase',
	'sequential-thinking': 'Sequential Thinking',
	github: 'GitHub',
	codegraph: 'CodeGraph',
	openai: 'OpenAI',
	deepseek: 'DeepSeek',
	nan: 'NaN',
};

/** `atlassian-rovo-mcp` → `Atlassian Rovo`, `aikido` → `Aikido`: the name as a person would write it. */
export function displayNameOf(id: string): string {
	const known = DISPLAY_NAMES[id.toLowerCase()];
	if (known !== undefined) {
		return known;
	}
	return id.split(/[-_]/).filter(word => word.length > 0 && word.toLowerCase() !== 'mcp' && word.toLowerCase() !== 'server')
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(' ') || id;
}

/** `https://…/v1` → `example.com`. Hostnames only; anything else yields nothing. */
function domainOf(endpoint: string | undefined): string | undefined {
	if (typeof endpoint !== 'string' || endpoint.length === 0) {
		return undefined;
	}
	try {
		const host = new URL(endpoint).hostname;
		// An address on the local network says nothing about the brand: `192.168.1.65` is somebody's
		// router, and a favicon request for it would hang.
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost') {
			return undefined;
		}
		return host;
	} catch {
		return undefined;
	}
}

/** Two letters for the avatar, from a provider id like `openai-codex` or `omni`. */
export function initialsOf(id: string): string {
	const parts = id.split(/[-_.]/).filter(part => part.length > 0);
	const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : id.slice(0, 2);
	return (letters || '?').toUpperCase();
}

/** A stable colour per name: the same provider always gets the same one. */
export function hueOf(id: string): number {
	let hash = 0;
	for (let index = 0; index < id.length; index += 1) {
		hash = (hash * 31 + id.charCodeAt(index)) % 360;
	}
	return hash;
}

/**
 * The known domain for an id, or for the family it belongs to: `qwen-token-plan-cn` and
 * `cloudflare-workers-ai` are regional or product variants of a service whose mark is the same.
 */
function knownDomainOf(id: string): string | undefined {
	const lower = id.toLowerCase();
	const exact = KNOWN_DOMAINS[lower];
	if (exact !== undefined) {
		return exact;
	}
	const parts = lower.split('-');
	for (let length = parts.length - 1; length > 0; length -= 1) {
		const family = KNOWN_DOMAINS[parts.slice(0, length).join('-')] ?? KNOWN_DOMAINS[parts.slice(0, length).join('')];
		if (family !== undefined) {
			return family;
		}
	}
	return undefined;
}

/**
 * The mark for one provider, as an element.
 *
 * Returns a **span** that starts as the initials avatar and upgrades itself to the real favicon if
 * one loads. Starting with the avatar means the row never shows a broken image, and the upgrade is
 * a single swap nobody has to wait for.
 */
export function createServiceLogo(id: string, endpoint?: string): HTMLElement {
	const mark = $('span.picode-pm-logo');
	const hue = hueOf(id);
	mark.style.background = `hsl(${hue} 55% 32%)`;
	mark.style.color = '#fff';
	mark.textContent = initialsOf(id);
	mark.title = id;

	const domain = knownDomainOf(id) ?? domainOf(endpoint);
	if (domain === undefined) {
		return mark;
	}

	const image = document.createElement('img');
	image.alt = '';
	mark.classList.toggle('dark-ink', DARK_INK_DOMAINS.has(domain));
	image.src = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
	image.addEventListener('load', () => {
		mark.textContent = '';
		mark.style.background = 'transparent';
		mark.appendChild(image);
	});
	addDisposableListener(image, 'error', () => {
		// Keep the initials: they are the fallback that always works.
	});
	return mark;
}
