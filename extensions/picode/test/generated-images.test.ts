/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Any image a tool makes is shown with the chat's generated-image design, whatever the provider,
 * the model or the way the tool hands it back: inside the result, as a saved file named in its
 * text (with or without words around the path), or as a link. Tools that only look at images
 * that already existed (reading a file, a browser screenshot) show nothing.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { generatedImagesOf, isImageCreationTool } from '../src/generated-images.ts';

const png = (seed = 1): Uint8Array => Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 2, 3, 4, 5, 6, 7, 8,
	0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const jpeg = (): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let root: string;
let server: Server;
let base: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), 'picode-generated-images-'));
	server = createServer((request, response) => {
		if (request.url === '/picture') {
			response.writeHead(200, { 'content-type': 'image/png' });
			response.end(Buffer.from(png()));
		} else if (request.url === '/page') {
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end('<html></html>');
		} else {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
	server.close();
	await rm(root, { recursive: true, force: true });
});

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });
const image = (bytes: Uint8Array, mimeType = 'image/png') => ({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType });
const options = () => ({ tempRoot: root, allowHttp: true });

test('image tools are recognised whatever they are called', () => {
	for (const name of [
		'mcp__nan_media__generate_image', 'generate_image', 'createImage', 'edit_picture', 'render_artwork',
		'dalle', 'dall-e-3', 'gpt_image', 'flux_schnell', 'stable_diffusion', 'sdxl_generate', 'midjourney_imagine',
		'ideogram', 'recraft_v3', 'seedream', 'text_to_image', 'txt2img', 'img2img', 'imagen_4', 'nano_banana',
		'draw_illustration', 'make_logo', 'photo_generation',
	]) {
		assert.equal(isImageCreationTool(name), true, name);
	}
	for (const name of ['read', 'bash', 'grep', 'browser_take_screenshot', 'take_screenshot', 'list_images', 'image_info', 'web_search']) {
		assert.equal(isImageCreationTool(name), false, name);
	}
});

test('a saved file named with words after the path is shown (NaN)', async () => {
	const file = join(root, 'biblioteca-nocturna.jpg');
	await writeFile(file, jpeg());
	const previews = await generatedImagesOf('mcp__nan_media__generate_image',
		text(`Image saved to ${file} (source URL: https://example.invalid/nan-images-prod/x?X-Amz-Signature=abc)`), options());
	assert.equal(previews.length, 1);
	assert.equal(previews[0].mimeType, 'image/jpeg');
});

test('saved files in a sentence, in a list, with spaces in the name and as file URIs are all shown', async () => {
	const one = join(root, 'with space.png');
	const two = join(root, 'second.webp');
	const three = join(root, 'third one.png');
	await writeFile(one, png(1));
	await writeFile(two, png(2));
	await writeFile(three, png(3));
	const uri = `file:///${three.replace(/\\/g, '/').replace(/ /g, '%20')}`;
	const previews = await generatedImagesOf('generate_image', text(`Created 3 images:\n- ${one}\n- ${two}, done.\nAlso at ${uri}.`), options());
	assert.equal(previews.length, 3);
});

test('the same picture handed back twice shows once', async () => {
	const file = join(root, 'twice.png');
	await writeFile(file, png(9));
	const previews = await generatedImagesOf('generate_image', { content: [image(png(9)), { type: 'text', text: `Saved to ${file}` }] }, options());
	assert.equal(previews.length, 1);
});

test('an image inside the result is shown for any tool that made it, codemode included', async () => {
	assert.equal((await generatedImagesOf('codemode', { content: [image(png()), { type: 'text', text: 'Saved to /tmp/x.png' }] }, options())).length, 1);
	assert.equal((await generatedImagesOf('some_unknown_mcp_tool', { content: [image(jpeg(), 'image/jpeg')] }, options())).length, 1);
});

test('a link to the generated image is downloaded and shown', async () => {
	const previews = await generatedImagesOf('text_to_image', text(`Here is your image: ${base}/picture`), options());
	assert.equal(previews.length, 1);
	assert.equal(previews[0].mimeType, 'image/png');
});

test('a link that is not an image is not shown', async () => {
	assert.deepEqual(await generatedImagesOf('generate_image', text(`Done: ${base}/page`), options()), []);
	assert.deepEqual(await generatedImagesOf('generate_image', text(`Done: ${base}/missing.png`), options()), []);
});

test('a local file is preferred over the link to the same image', async () => {
	const file = join(root, 'local.png');
	await writeFile(file, png());
	const previews = await generatedImagesOf('generate_image', text(`Saved ${file} (source URL: ${base}/picture)`), options());
	assert.equal(previews.length, 1);
});

test('tools that only look at existing images show nothing', async () => {
	const file = join(root, 'existing.png');
	await writeFile(file, png());
	for (const name of ['read', 'browser_take_screenshot', 'take_screenshot', 'view_image']) {
		assert.deepEqual(await generatedImagesOf(name, { content: [image(png()), { type: 'text', text: file }] }, options()), [], name);
	}
});

test('a tool that is not about images does not get its paths turned into pictures', async () => {
	const file = join(root, 'listed.png');
	await writeFile(file, png());
	assert.deepEqual(await generatedImagesOf('bash', text(`ls output:\n${file}`), options()), []);
});

test('a plain http link is not fetched outside tests', async () => {
	assert.deepEqual(await generatedImagesOf('generate_image', text(`${base}/picture`), { tempRoot: root }), []);
});
