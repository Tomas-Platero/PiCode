/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pasted images reach pi whole or not at all: a cut-off file makes the provider answer 400
 * ("the file looks truncated or corrupted") and ends every later turn of the conversation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imagesOf, sniffImage } from '../src/chat-images.ts';
import { generatedImagesOf } from '../src/generated-images.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = (tail = true): Uint8Array => Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
	...(tail ? [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] : []),
]);

test('generated image bytes and an image tool path are copied to the temporary preview directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'picode-preview-test-'));
	try {
		const source = join(root, 'source image.png');
		await writeFile(source, png());
		const content = [
			{ type: 'image', data: Buffer.from(png()).toString('base64') },
			{ type: 'text', text: 'Generated: `' + source + '`' },
		];
		// The same picture inside the result and as the saved file shows once.
		const previews = await generatedImagesOf('mcp_generate_image', { content }, root);
		assert.equal(previews.length, 1);
		for (const preview of previews) {
			assert.equal(preview.mimeType, 'image/png');
			assert.notEqual(preview.path, source);
			assert.deepEqual(await readFile(preview.path), Buffer.from(png()));
		}
		assert.deepEqual(await generatedImagesOf('read', { content }, root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a whole PNG is accepted and a cut-off one is not', () => {
	assert.equal(sniffImage(png()), 'image/png');
	assert.equal(sniffImage(png(false)), undefined);
});

test('the type comes from the bytes, not from what the editor claimed', () => {
	const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xff, 0xd9]);
	assert.equal(sniffImage(jpeg), 'image/jpeg');
	assert.equal(sniffImage(new Uint8Array(32)), undefined);
});

test('only image references are read; a broken one is named and left out', async () => {
	const reference = (id: string, mimeType: string, bytes: Uint8Array) => ({ id, value: { mimeType, data: async () => bytes } }) as never;
	const result = await imagesOf([
		reference('ok.png', 'image/png', png()),
		reference('cut.png', 'image/png', png(false)),
		reference('notes.txt', 'text/plain', new Uint8Array(0)),
	]);
	assert.deepEqual(result.images.map(image => image.mimeType), ['image/png']);
	assert.deepEqual(result.skipped, ['cut.png']);
});
