import { createHash } from 'node:crypto';
import { constants, rmSync } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MAX_IMAGE_BYTES, sniffImage } from './chat-images.ts';

/**
 * Images a tool makes, shown in the chat with the generated-image design whatever the provider,
 * the model or the tool: an image inside the result, a saved file named anywhere in its text
 * (`Image saved to C:\…\x.jpg (source URL: …)`), a `file://` address, or a link to download.
 *
 * Only what the tool answered is read, never paths the model writes. Tools that only look at
 * images that already existed (reading a file, a browser screenshot) never get previews.
 */

const MAX_PREVIEWS = 4;
const MAX_LINKS = 4;
const MAX_TEXT = 16_384;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1000;
const previewDirectories = new Set<string>();
const extensions: Readonly<Record<string, string>> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
};

/** Tools that look at an image that was already there: what they return is not something they made. */
const LOOKS_AT_EXISTING = /(?:^(?:read|ls|find|grep|glob)$|screenshot|screen.?shot|capture|snapshot|browser|playwright|view|read_|_read|info|list|describe|analy[sz]e|ocr|search)/i;
/** Image models and services, by name. */
const IMAGE_SERVICE = /(?:imagen|nano.?banana|dall.?e|gpt.?image|flux|stable.?diffusion|sdxl|midjourney|ideogram|recraft|seedream|txt2img|text.?to.?image|text2image|img2img|image.?to.?image)/i;
const IMAGE_SUBJECT = /(?:image|picture|artwork|photo|illustration|drawing|logo|icon|wallpaper|sticker|avatar)/i;
const MAKING = /(?:generat|creat|edit|render|draw|paint|make|produce|design|imagin)/i;

function looksAtExisting(toolName: string): boolean {
	return LOOKS_AT_EXISTING.test(toolName);
}

/** A tool whose job is to make or change images, whatever it is called. */
export function isImageCreationTool(toolName: string): boolean {
	return !looksAtExisting(toolName)
		&& (IMAGE_SERVICE.test(toolName) || (IMAGE_SUBJECT.test(toolName) && MAKING.test(toolName)));
}

const IMAGE_FILE = String.raw`\.(?:png|jpe?g|gif|webp)(?![\w-])`;
/** `C:\out\a b.png`, also inside a sentence: from the drive to the first image extension. */
const WINDOWS_PATH = new RegExp(String.raw`(?<![\w])[A-Za-z]:[\\/][^\r\n<>"'\`|?*]*?` + IMAGE_FILE, 'gi');
/** `/tmp/a.png`, never a piece of a web address. */
const POSIX_PATH = new RegExp(String.raw`(?<![\w:/.%-])/(?!/)[^\s<>"'\`|?*]*?` + IMAGE_FILE, 'gi');
const FILE_URI = new RegExp(String.raw`file:///?[^\s<>"'\`)]+?` + IMAGE_FILE, 'gi');
const LINK = /https?:\/\/[^\s<>"'`)\]]+/gi;

function isLocalPath(path: string): boolean {
	return isAbsolute(path) && !/^[\\/]{2}/.test(path);
}

function fromFileUri(uri: string): string | undefined {
	try {
		const path = decodeURIComponent(uri.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/'));
		return process.platform === 'win32' ? path.replace(/\//g, '\\') : path;
	} catch {
		return undefined;
	}
}

/** Every saved image a text names, in the order it names them. */
function pathsIn(text: string): string[] {
	const found: { index: number; path: string }[] = [];
	for (const match of text.matchAll(FILE_URI)) {
		const path = fromFileUri(match[0]);
		if (path) {
			found.push({ index: match.index ?? 0, path });
		}
	}
	const withoutUris = text.replace(FILE_URI, m => ' '.repeat(m.length));
	for (const pattern of process.platform === 'win32' ? [WINDOWS_PATH] : [POSIX_PATH, WINDOWS_PATH]) {
		for (const match of withoutUris.matchAll(pattern)) {
			found.push({ index: match.index ?? 0, path: match[0] });
		}
	}
	return found.sort((a, b) => a.index - b.index).map(entry => entry.path);
}

function linksIn(text: string): string[] {
	return [...text.matchAll(LINK)].map(match => match[0].replace(/[.,;:!?]+$/, '')).slice(0, MAX_LINKS);
}

async function readImage(path: string): Promise<Buffer | undefined> {
	if (!isLocalPath(path)) {
		return undefined;
	}
	const resolved = await realpath(path);
	if (!isLocalPath(resolved) || !(await lstat(resolved)).isFile()) {
		return undefined;
	}
	const flags = process.platform === 'win32'
		? constants.O_RDONLY
		: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	const file = await open(resolved, flags);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
			return undefined;
		}
		const bytes = Buffer.alloc(stat.size);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		return bytesRead === bytes.length ? bytes : undefined;
	} finally {
		await file.close();
	}
}

/** Downloads a link the tool gave, when it is an image: bounded in time and size, https only. */
async function downloadImage(link: string, allowHttp: boolean): Promise<Buffer | undefined> {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
		return undefined;
	}
	const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok || !response.body) {
		return undefined;
	}
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (declared > MAX_IMAGE_BYTES) {
		await response.body.cancel();
		return undefined;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body.getReader();
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.byteLength;
		if (size > MAX_IMAGE_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function removePreviewsOnExit(): void {
	for (const directory of previewDirectories) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// The OS may still have the preview open during shutdown.
		}
	}
}

interface GeneratedImage {
	readonly path: string;
	readonly mimeType: string;
}

export interface GeneratedImagesOptions {
	/** Where the preview copies go (tests use their own folder). */
	readonly tempRoot?: string;
	/** Tests only: lets the download of a link use a local `http://` server. */
	readonly allowHttp?: boolean;
}

/** Accept only successful tool output, never paths suggested by the model. */
export async function generatedImagesOf(toolName: string, result: unknown, options: GeneratedImagesOptions | string = {}): Promise<GeneratedImage[]> {
	const { tempRoot = tmpdir(), allowHttp = false } = typeof options === 'string' ? { tempRoot: options } : options;
	if (looksAtExisting(toolName)) {
		return [];
	}
	const makesImages = isImageCreationTool(toolName);
	const content = (result as { content?: unknown } | undefined)?.content;
	const parts: unknown[] = Array.isArray(content) ? content : [{ type: 'text', text: result }];
	const previews: GeneratedImage[] = [];
	const seen = new Set<string>();
	let directory: string | undefined;

	const keep = async (bytes: Buffer | undefined): Promise<boolean> => {
		const mimeType = bytes && sniffImage(bytes);
		if (!bytes || !mimeType || previews.length >= MAX_PREVIEWS) {
			return false;
		}
		// The same picture handed back twice (inside the result and as a saved file) shows once.
		const digest = createHash('sha256').update(bytes).digest('hex');
		if (seen.has(digest)) {
			return true;
		}
		seen.add(digest);
		if (!directory) {
			const created = await mkdtemp(join(tempRoot, 'picode-images-'));
			directory = created;
			if (previewDirectories.size === 0) {
				process.once('exit', removePreviewsOnExit);
			}
			previewDirectories.add(created);
			setTimeout(() => {
				void rm(created, { recursive: true, force: true }).then(() => {
					previewDirectories.delete(created);
					if (previewDirectories.size === 0) {
						process.off('exit', removePreviewsOnExit);
					}
				}, () => undefined);
			}, PREVIEW_LIFETIME_MS).unref();
		}
		const path = join(directory, `generated-image-${previews.length + 1}${extensions[mimeType]}`);
		await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
		previews.push({ path, mimeType });
		return true;
	};
	const attempt = async (load: () => Promise<Buffer | undefined>): Promise<boolean> => {
		try {
			return await keep(await load());
		} catch {
			// One unreadable file or link should not hide the tool's other previews or stop the chat.
			return false;
		}
	};

	for (const part of parts.slice(0, 16)) {
		if (previews.length >= MAX_PREVIEWS) {
			break;
		}
		if (!part || typeof part !== 'object') {
			continue;
		}
		const { type, data, text } = part as { type?: unknown; data?: unknown; text?: unknown };
		// An image in the result was made by the tool: any tool that is not just looking at one.
		if (type === 'image' && typeof data === 'string' && data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
			await attempt(async () => Buffer.from(data, 'base64'));
			continue;
		}
		// Files and links named in text count only for tools that make images: a listing that names
		// a picture is not a picture the tool made.
		if (!makesImages || type !== 'text' || typeof text !== 'string' || text.length > MAX_TEXT) {
			continue;
		}
		let local = false;
		for (const path of pathsIn(text)) {
			local = await attempt(() => readImage(path)) || local;
		}
		// A link is the same image when the tool saved it too ("source URL"): only without a file.
		if (!local) {
			for (const link of linksIn(text)) {
				await attempt(() => downloadImage(link, allowHttp));
			}
		}
	}
	return previews;
}
