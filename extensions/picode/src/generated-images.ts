import { constants, rmSync } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MAX_IMAGE_BYTES, sniffImage } from './chat-images.ts';

const MAX_PREVIEWS = 4;
const PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1000;
const previewDirectories = new Set<string>();
const extensions: Readonly<Record<string, string>> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
};

export function isImageCreationTool(toolName: string): boolean {
	return /(?:imagen|nano.?banana)/i.test(toolName)
		|| (/(?:image|picture|artwork)/i.test(toolName) && /(?:generat|creat|edit|render)/i.test(toolName));
}

function isLocalPath(path: string): boolean {
	return isAbsolute(path) && !/^[\\/]{2}/.test(path);
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

/** Accept only successful image creation/edit tool output, never paths suggested by the model. */
export async function generatedImagesOf(toolName: string, result: unknown, tempRoot = tmpdir()): Promise<GeneratedImage[]> {
	if (!isImageCreationTool(toolName)) {
		return [];
	}
	const content = (result as { content?: unknown } | undefined)?.content;
	const parts: unknown[] = Array.isArray(content) ? content : [{ type: 'text', text: result }];
	const previews: GeneratedImage[] = [];
	let directory: string | undefined;
	for (const part of parts.slice(0, 16)) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const { type, data, text } = part as { type?: unknown; data?: unknown; text?: unknown };
		try {
			let bytes: Buffer | undefined;
			if (type === 'image' && typeof data === 'string' && data.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
				bytes = Buffer.from(data, 'base64');
			} else if (type === 'text' && typeof text === 'string' && text.length <= 4096) {
				// A path can be quoted, Markdown code, or a whole output line. Keep spaces in filenames.
				const path = /(?:^|[\s`"'(])((?:[A-Za-z]:[\\/]|\/(?!\/))[^\r\n`"']+?\.(?:png|jpe?g|gif|webp))(?=$|[`"')\r\n]|\s*$)/im.exec(text)?.[1];
				bytes = path ? await readImage(path) : undefined;
			}
			const mimeType = bytes && sniffImage(bytes);
			if (!bytes || !mimeType) {
				continue;
			}
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
			if (previews.length === MAX_PREVIEWS) {
				break;
			}
		} catch {
			// One unreadable result should not hide the tool's other previews or stop the chat.
		}
	}
	return previews;
}
