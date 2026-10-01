#!/usr/bin/env node
/*
 * Takes the picture out of an `.ico`, as a PNG.
 *
 * Windows wants an `.ico` and Linux wants a `.png`, and the repository carries one drawing: the
 * `.ico` is built from PiCode's mark in seven sizes, and its large frames are already PNG — the
 * format allows it, and nothing else would fit a 256 px frame. So the Linux icon comes out of the
 * same file, with no image library and no second copy of the drawing to keep in step.
 *
 * The largest frame is the one written: an icon is scaled down well and up badly.
 *
 * Usage: node dev/ico-to-png.mjs <file.ico> <file.png>
 */

import * as fs from 'node:fs';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
	process.stderr.write('usage: node dev/ico-to-png.mjs <file.ico> <file.png>\n');
	process.exit(2);
}

let buffer;
try {
	buffer = fs.readFileSync(source);
} catch (error) {
	process.stderr.write(`the icon could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}

// The header: reserved(2) type(2) count(2), then one sixteen-byte entry per image.
if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
	process.stderr.write(`${source} is not an icon file\n`);
	process.exit(2);
}

const count = buffer.readUInt16LE(4);
const frames = [];
for (let index = 0; index < count; index += 1) {
	const entry = 6 + index * 16;
	if (entry + 16 > buffer.length) {
		break;
	}
	// 0 means 256 in this field, which is the largest an icon frame can be.
	const width = buffer.readUInt8(entry) || 256;
	const height = buffer.readUInt8(entry + 1) || 256;
	const size = buffer.readUInt32LE(entry + 8);
	const offset = buffer.readUInt32LE(entry + 12);
	if (offset + size > buffer.length) {
		continue;
	}
	const frame = buffer.subarray(offset, offset + size);
	// A PNG starts with its own signature; anything else is a bitmap this cannot read.
	const isPng = frame.length > 8 && frame.readUInt32BE(0) === 0x89504e47 && frame.readUInt32BE(4) === 0x0d0a1a0a;
	if (isPng) {
		frames.push({ width, height, frame });
	}
}

if (frames.length === 0) {
	process.stderr.write(`${source} has no PNG frame: this needs an icon built with PNG frames\n`);
	process.exit(1);
}

frames.sort((left, right) => right.width * right.height - left.width * left.height);
fs.writeFileSync(target, frames[0].frame);
process.stdout.write(`${target}: ${frames[0].width}x${frames[0].height} out of ${frames.length} PNG frame(s)\n`);
