import type * as vscode from 'vscode';

/** One image as pi takes it: base64 and its type. */
export interface PiImage {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

export interface ChatImages {
	readonly images: readonly PiImage[];
	/** Names of the attachments that were left out because they could not be read as an image. */
	readonly skipped: readonly string[];
}

/** Providers reject far smaller payloads than this; one that large is not a screenshot. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** The binary reference the chat gives for a pasted or attached image, recognised by its shape. */
interface BinaryReference {
	readonly mimeType: string;
	data(): Thenable<Uint8Array>;
}

function isBinaryReference(value: unknown): value is BinaryReference {
	return typeof value === 'object' && value !== null
		&& typeof (value as { mimeType?: unknown }).mimeType === 'string'
		&& typeof (value as { data?: unknown }).data === 'function';
}

/**
 * The image's real type from its first bytes, or undefined when it is not a PNG, JPEG, WebP or GIF
 * that is whole. A provider answers a cut-off file with a 400 that ends the whole turn, and the bad
 * image would stay in the conversation, so it is checked here, before it can be sent.
 */
export function sniffImage(bytes: Uint8Array): string | undefined {
	const startsWith = (...signature: number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
	if (bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES) {
		return undefined;
	}
	if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
		// A whole PNG ends with its IEND chunk (type, then a 4-byte checksum).
		const end = bytes.length - 8;
		return bytes[end] === 0x49 && bytes[end + 1] === 0x45 && bytes[end + 2] === 0x4e && bytes[end + 3] === 0x44 ? 'image/png' : undefined;
	}
	if (startsWith(0xff, 0xd8, 0xff)) {
		return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 ? 'image/jpeg' : undefined;
	}
	if (startsWith(0x47, 0x49, 0x46, 0x38)) {
		return bytes[bytes.length - 1] === 0x3b ? 'image/gif' : undefined;
	}
	if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		return 'image/webp';
	}
	return undefined;
}

/** The request's image attachments, read and checked. Other references are not touched. */
export async function imagesOf(references: readonly vscode.ChatPromptReference[] | undefined): Promise<ChatImages> {
	const images: PiImage[] = [];
	const skipped: string[] = [];
	for (const reference of references ?? []) {
		if (!isBinaryReference(reference.value) || !reference.value.mimeType.startsWith('image/')) {
			continue;
		}
		const name = (reference as { readonly name?: string }).name ?? reference.id;
		try {
			const bytes = await reference.value.data();
			const mimeType = sniffImage(bytes);
			if (mimeType === undefined) {
				skipped.push(name);
				continue;
			}
			images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType });
		} catch {
			skipped.push(name);
		}
	}
	return { images, skipped };
}
