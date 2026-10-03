#!/usr/bin/env node
/*
 * Writes the tall picture Inno Setup wants for the installer's sidebar.
 *
 * The wizard takes two pictures. The small one is the mark itself, and the repository already has
 * it finished (resources/win32/code_150x150.png, the tile Windows shows in the Start menu), so the
 * .iss points straight at that file. The tall one has no asset: the sidebar is 164x314 and every
 * PiCode drawing in the tree is square. This is what makes it, by putting the same finished mark
 * on a PiCode-coloured panel.
 *
 * No image library and no renderer: PNG is zlib plus a byte of bookkeeping per row, and node has
 * zlib. Reading the source is the same promise dev/ico-to-png.mjs makes for the Linux icon - one
 * drawing, reused, with nothing new added to package.json to move it around.
 *
 * Run by hand, like dev/ico-to-png.mjs: the pictures are build inputs and get committed.
 *
 * Usage: node dev/make-inno-images.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const ROOT = path.dirname(import.meta.dirname);
const WIN32 = path.join(ROOT, 'picode-source', 'resources', 'win32');
const SOURCE = path.join(WIN32, 'code_150x150.png');

// The panel, top to bottom, and the blue the mark itself is accented with.
const TOP = [0x27, 0x27, 0x2d];
const BOTTOM = [0x15, 0x15, 0x1a];
const GLOW = [0x3b, 0x9d, 0xff];

// The pixel sizes of the sidebar Inno is handed, at 100% through 250%. Inno picks one by the
// display's scaling factor, so a missing entry means no picture on those machines.
const LADDER = [[100, 164, 314], [125, 192, 386], [150, 246, 459], [175, 273, 556], [200, 328, 604], [225, 355, 700], [250, 410, 797]];

// ---------------------------------------------------------------------------
// PNG, read
// ---------------------------------------------------------------------------

function readPng(file) {
	const buf = fs.readFileSync(file);
	const idat = [];
	let width = 0, height = 0;
	let pos = 8;

	while (pos < buf.length) {
		const length = buf.readUInt32BE(pos);
		const type = buf.toString('ascii', pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + length);

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || data[9] !== 6) {
				throw new Error(`${file}: expected an 8-bit RGBA PNG`);
			}
			if (data[12] !== 0) {
				throw new Error(`${file}: interlaced PNGs are not supported`);
			}
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}

		pos += 12 + length;
	}

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const bpp = 4;
	const stride = width * bpp;
	const pixels = Buffer.alloc(stride * height);

	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = pixels.subarray(y * stride, (y + 1) * stride);
		const prior = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);

		for (let i = 0; i < stride; i++) {
			const left = i >= bpp ? out[i - bpp] : 0;
			const above = prior[i];
			const corner = i >= bpp ? prior[i - bpp] : 0;
			let value = line[i];

			switch (filter) {
				case 0: break;
				case 1: value += left; break;
				case 2: value += above; break;
				case 3: value += (left + above) >> 1; break;
				case 4: {
					const p = left + above - corner;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - above);
					const pc = Math.abs(p - corner);
					value += pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
					break;
				}
				default:
					throw new Error(`${file}: unknown filter type ${filter}`);
			}

			out[i] = value & 0xff;
		}
	}

	return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// PNG, write
// ---------------------------------------------------------------------------

function writePng(file, width, height, pixels) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);

	for (let y = 0; y < height; y++) {
		// Filter 0: the panel is a smooth gradient, and deflate already has it.
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	const chunk = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
		return Buffer.concat([head, data, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;

	fs.writeFileSync(file, Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]));
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

// Bilinear: the mark is drawn at up to 1.3x the source, where nearest would show its edges.
function sample(src, x, y) {
	const x0 = Math.floor(x), y0 = Math.floor(y);
	const fx = x - x0, fy = y - y0;
	const at = (px, py) => {
		const cx = Math.min(Math.max(px, 0), src.width - 1);
		const cy = Math.min(Math.max(py, 0), src.height - 1);
		const o = (cy * src.width + cx) * 4;
		return [src.pixels[o], src.pixels[o + 1], src.pixels[o + 2], src.pixels[o + 3]];
	};
	const a = at(x0, y0), b = at(x0 + 1, y0);
	const c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
	const out = [0, 0, 0, 0];
	for (let i = 0; i < 4; i++) {
		out[i] = (a[i] * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy;
	}
	return out;
}

function panel(mark, width, height) {
	const pixels = Buffer.alloc(width * height * 4);
	const size = Math.round(width * 0.55);
	const left = Math.round((width - size) / 2);
	const top = Math.round((height - size) / 2);
	const glowRadius = size * 1.5;
	const glowX = width / 2;
	const glowY = top + size / 2;

	for (let y = 0; y < height; y++) {
		const t = y / (height - 1);
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;

			for (let c = 0; c < 3; c++) {
				pixels[o + c] = Math.round(TOP[c] * (1 - t) + BOTTOM[c] * t);
			}
			// The panel is opaque: alpha starts at 0 in a fresh buffer, and a PNG that kept it
			// would hand Inno a transparent picture.
			pixels[o + 3] = 255;

			// A soft bloom behind the mark, so the panel is not a flat rectangle.
			const distance = Math.hypot(x - glowX, y - glowY);
			const strength = Math.max(0, 1 - distance / glowRadius) ** 2 * 0.22;
			for (let c = 0; c < 3; c++) {
				pixels[o + c] = Math.round(pixels[o + c] * (1 - strength) + GLOW[c] * strength);
			}

			const sx = (x - left) / size * mark.width;
			const sy = (y - top) / size * mark.height;
			if (sx < 0 || sy < 0 || sx >= mark.width || sy >= mark.height) {
				continue;
			}

			// The mark's own alpha, so its rounded tile keeps its corners.
			const [r, g, b, a] = sample(mark, sx, sy);
			const alpha = a / 255;
			pixels[o] = Math.round(pixels[o] * (1 - alpha) + r * alpha);
			pixels[o + 1] = Math.round(pixels[o + 1] * (1 - alpha) + g * alpha);
			pixels[o + 2] = Math.round(pixels[o + 2] * (1 - alpha) + b * alpha);
			pixels[o + 3] = 255;
		}
	}

	return pixels;
}

// ---------------------------------------------------------------------------

const mark = readPng(SOURCE);

for (const [percent, width, height] of LADDER) {
	const file = path.join(WIN32, `inno-big-${percent}.png`);
	writePng(file, width, height, panel(mark, width, height));
	console.log(`${path.relative(ROOT, file)} ${width}x${height}`);
}
