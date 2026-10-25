#!/usr/bin/env node
/*
 * branding -- PiCode's marks on the editor's files.
 *
 * Names, icons and the pictures Inno Setup needs, so nothing the build produces
 * still says Visual Studio Code.
 *
 * Usage:
 *   node build/branding.mjs brand-copy
 *   node build/branding.mjs make-inno-images
 *   node build/branding.mjs ico-to-png
 *   node build/branding.mjs patch-inno-updater
 *
 * One file per domain: the scripts that used to sit side by side in build/ were fused
 * here, each keeping its own explanation directly above the code it runs. Commands are
 * functions, so this file can also be imported (build/checks.mjs imports resolvePack)
 * without anything running.
 */

import { pathToFileURL } from 'node:url';
	// brand-copy -- was build/brand-copy.mjs
	/*
	 * PiCode's name, on the editor's own copy.
	 *
	 * The editor is built from VS Code's source, and its text says so: measured, 196 of its 24,697
	 * user-facing strings name "VS Code", "VSCode" or "VSCodium". The product's own strings (this
	 * repository's patches, the connector, the settings) already say PiCode; these are the ones that
	 * come from upstream, and they are the ones a person reads in the settings, in the panels and in
	 * the extension list of a product that is not called that.
	 *
	 * ## What it touches, and what it must not
	 *
	 * Only **copy**: the editor's message table (`out/nls.messages.json`, which is what every screen
	 * reads from) and the built-in extensions' manifests (`package.json` / `package.nls.json`, where
	 * descriptions live). The bundles hold indices into that table, so nothing else needs rewriting.
	 *
	 * It replaces the brand **as written for a person** — `VS Code`, `VSCode`, `VSCodium`, `Visual
	 * Studio Code` — and leaves everything that would break by being renamed:
	 *
	 *   - identifiers and packages: `@vscode/…`, `vscode-…`, `microsoft/vscode`, `.vscode`, and the
	 *     `vscode:` URI scheme (all lower case, so the capitalised forms never match them anyway);
	 *   - URLs (`code.visualstudio.com`, `aka.ms/vscode…`): renaming one would break the link and be a
	 *     lie about where it goes;
	 *   - the licensing and attribution files (`LICENSE*`, `ThirdPartyNotices*`): the lineage is
	 *     upstream's and stating otherwise would be false.
	 *
	 * Usage: node build/branding.mjs brand-copy [pack-dir] [--check]
	 */
	async function cmdBrandCopy(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const REPO = path.resolve(import.meta.dirname, '..');
	const args = cli;
	const checkOnly = args.includes('--check');
	const packArg = args.find(argument => !argument.startsWith('--'));
	const PACK = path.resolve(packArg ?? path.join(REPO, 'PiCode-Win32-x64'));
	const APP = path.join(PACK, 'resources', 'app');

	/** The brand, as a person writes it. Lower-case identifiers never match these. */
	const BRAND = [
		[/\bVisual Studio Code\b/g, 'PiCode'],
		[/\bVS Code\b/g, 'PiCode'],
		[/\bVSCode\b/g, 'PiCode'],
		[/\bVSCodium\b/g, 'PiCode'],
	];

	/** Files whose text is a promise about where something came from, and must not be rewritten. */
	const DO_NOT_TOUCH = /(^|[\\/])(LICENSE|ThirdPartyNotices|LICENSES)/i;

	/** Where PiCode's own copy lives: the extension the editor shows as built in. */
	const OURS = /picode/i;

	let rewritten = 0;
	let strings = 0;
	const samples = [];

	function brand(text) {
		let out = text;
		for (const [pattern, replacement] of BRAND) {
			out = out.replace(pattern, replacement);
		}
		return out;
	}

	function rewriteText(file) {
		const before = fs.readFileSync(file, 'utf8');
		const after = brand(before);
		if (after === before) {
			return;
		}
		const changed = before.split('\n').length === after.split('\n').length;
		rewritten += 1;
		// One sample per file is enough to see what it did, and the count says how much.
		const line = before.split('\n').find(line => brand(line) !== line) ?? '';
		const clean = line.replace(/\\u001b\[[0-9;]*m/g, '').trim();
		if (clean.length > 0 && samples.length < 12) {
			samples.push(`  ${path.relative(PACK, file)}\n    - ${clean.slice(0, 120)}\n    + ${brand(clean).slice(0, 120)}`);
		}
		if (changed && !checkOnly) {
			fs.writeFileSync(file, after);
		}
	}

	/** Every string value in a JSON document, rewritten in place, keys left alone. */
	function rewriteJsonStrings(value, insidePackages = false) {
		if (typeof value === 'string') {
			strings += 1;
			return brand(value);
		}
		if (Array.isArray(value)) {
			return value.map(entry => rewriteJsonStrings(entry, insidePackages));
		}
		if (typeof value === 'object' && value !== null) {
			const out = {};
			for (const [key, entry] of Object.entries(value)) {
				out[key] = rewriteJsonStrings(entry, insidePackages);
			}
			return out;
		}
		return value;
	}

	function rewriteJson(file) {
		let document;
		const before = fs.readFileSync(file, 'utf8');
		try {
			document = JSON.parse(before);
		} catch {
			// A manifest that cannot be read is left as it is: this rewrites copy, it does not repair files.
			return;
		}
		const after = rewriteJsonStrings(document);
		const text = `${JSON.stringify(after, null, '\t')}\n`;
		if (text !== before) {
			rewritten += 1;
			if (!checkOnly) {
				fs.writeFileSync(file, text);
			}
		}
	}

	if (!fs.existsSync(APP)) {
		process.stderr.write(`No editor to rewrite at ${APP}\n`);
		process.exit(2);
	}

	// 1. The editor's message table: every screen reads its text from here.
	const table = path.join(APP, 'out', 'nls.messages.json');
	if (fs.existsSync(table)) {
		let before;
		try {
			before = JSON.parse(fs.readFileSync(table, 'utf8'));
		} catch (error) {
			process.stderr.write(`the message table could not be read: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(2);
		}
		const branded = rewriteJsonStrings(before);
		const changed = branded.filter((message, index) => message !== before[index]).length;
		rewritten += changed;
		strings += before.length;
		if (changed > 0 && !checkOnly) {
			fs.writeFileSync(table, JSON.stringify(branded));
		}
		process.stdout.write(`message table: ${changed} of ${before.length} strings named the other editor\n`);
	}

	// 2. The built-in extensions' manifests: their own descriptions, which the Extensions view shows.
	const extensionsDir = path.join(APP, 'extensions');
	if (fs.existsSync(extensionsDir)) {
		for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || OURS.test(entry.name)) {
				// PiCode's own extension is written by us and already says PiCode everywhere.
				continue;
			}
			const directory = path.join(extensionsDir, entry.name);
			for (const name of fs.readdirSync(directory)) {
				if (!/^(package\.nls|package)\.json$|^package\.nls\.[a-z-]+\.json$/.test(name)) {
					continue;
				}
				const file = path.join(directory, name);
				if (DO_NOT_TOUCH.test(file)) {
					continue;
				}
				rewriteJson(file);
			}
		}
		process.stdout.write(`extension manifests: ${rewritten} file(s) rewritten\n`);
	}

	if (samples.length > 0) {
		process.stdout.write('\nwhat it changed, a sample:\n');
		process.stdout.write(samples.join('\n') + '\n');
	}

	process.stdout.write(`\n${checkOnly ? 'would rewrite' : 'rewrote'} ${rewritten} place(s) over ${strings} string(s)\n`);
	}

	// make-inno-images -- was build/make-inno-images.mjs
	/*
	 * Writes the pictures Inno Setup wants for the installer's wizard.
	 *
	 * Two pictures. The tally one for the sidebar, and the square one for the corner of every page.
	 * The repository has the drawing already: resources/win32/code_150x150.png, the finished mark
	 * (the tile Windows shows in the Start menu). The sidebar is 164x314 and every PiCode drawing is
	 * square, so the tall file is the mark laid out on a PiCode-coloured panel; the square one is the
	 * same panel at the corner's size.
	 *
	 * Both are **BMP**, and that is not a preference. Inno Setup 6.4.1 - the version the build bundles
	 * - only reads BMP for WizardImageFile and WizardSmallImageFile. Handing it a PNG compiles fine and
	 * then kills the installer the moment the wizard opens, with the message "Bitmap image is not
	 * valid.": Setup looks for a PNG signature, does not find one, falls back to its bitmap reader and
	 * the bitmap reader is right that a PNG is not a BMP. So the pictures are 24-bit BMPs.
	 *
	 * No image library and no renderer: a BMP is a 54-byte header and rows of BGR, and node writes both
	 * without help. Reading the source is the same promise build/branding.mjs ico-to-png makes for the Linux icon -
	 * one drawing, reused, with nothing new added to package.json to move it around.
	 *
	 * Run by hand, like build/branding.mjs ico-to-png: the pictures are build inputs and get committed.
	 *
	 * Usage: node build/branding.mjs make-inno-images
	 */
	async function cmdMakeInnoImages(cli) {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const zlib = await import('node:zlib');
	const ROOT = path.dirname(import.meta.dirname);
	const WIN32 = path.join(ROOT, 'resources', 'win32');
	const SOURCE = path.join(WIN32, 'code_150x150.png');

	// The panel, top to bottom, and the blue the mark itself is accented with.
	const TOP = [0x27, 0x27, 0x2d];
	const BOTTOM = [0x15, 0x15, 0x1a];
	const GLOW = [0x3b, 0x9d, 0xff];

	// The pixel sizes of the sidebar Inno is handed, at 100% through 250%. Inno picks one by the
	// display's scaling factor, so a missing entry means no picture on those machines.
	const LADDER = [[100, 164, 314], [125, 192, 386], [150, 246, 459], [175, 273, 556], [200, 328, 604], [225, 355, 700], [250, 410, 797]];

	// The corner picture is square and Inno shrinks it to the page's own size (58x58 at 100%). It is
	// drawn larger than that so it still has pixels to lose on a high-DPI screen.
	const SMALL = 150;

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
						let nearest = corner;
						if (pa <= pb && pa <= pc) {
							nearest = left;
						} else if (pb <= pc) {
							nearest = above;
						}
						value += nearest;
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
	// BMP, write
	// ---------------------------------------------------------------------------

	// A bottom-up 24-bit BMP with a plain BITMAPINFOHEADER. The layout is unforgiving and there is no
	// reader here to catch a mistake: two bytes left out of the header make the fields after them slide
	// and Windows refuses the whole file - which is exactly how the first attempt at these pictures
	// died. So the header is written field by field, in the order the format lists them.
	function writeBmp(file, width, height, rgba) {
		// Rows are padded to a four-byte boundary. 164*3 is already a multiple of four, but a width
		// like the square picture's is not, so the padding is real.
		const stride = ((width * 3) + 3) & ~3;
		const imageSize = stride * height;
		const buf = Buffer.alloc(54 + imageSize);

		buf.write('BM', 0, 'ascii');                 // bfType
		buf.writeUInt32LE(buf.length, 2);            // bfSize
		buf.writeUInt32LE(0, 6);                     // bfReserved1 + bfReserved2
		buf.writeUInt32LE(54, 10);                   // bfOffBits

		buf.writeUInt32LE(40, 14);                   // biSize
		buf.writeInt32LE(width, 18);                 // biWidth
		buf.writeInt32LE(height, 22);                // biHeight (positive: rows run bottom-up)
		buf.writeUInt16LE(1, 26);                    // biPlanes - always 1
		buf.writeUInt16LE(24, 28);                   // biBitCount
		buf.writeUInt32LE(0, 30);                    // biCompression = BI_RGB
		buf.writeUInt32LE(imageSize, 34);            // biSizeImage
		buf.writeInt32LE(0, 38);                     // biXPelsPerMeter
		buf.writeInt32LE(0, 42);                     // biYPelsPerMeter
		buf.writeUInt32LE(0, 46);                    // biClrUsed
		buf.writeUInt32LE(0, 50);                    // biClrImportant

		for (let y = 0; y < height; y++) {
			const row = 54 + (height - 1 - y) * stride;
			for (let x = 0; x < width; x++) {
				const o = (y * width + x) * 4;
				buf[row + x * 3] = rgba[o + 2];      // B
				buf[row + x * 3 + 1] = rgba[o + 1];  // G
				buf[row + x * 3 + 2] = rgba[o];      // R
			}
		}

		fs.writeFileSync(file, buf);
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
				// The panel is opaque: alpha starts at 0 in a fresh buffer, and a BMP keeps no alpha
				// channel, so the mark has to be flattened onto the panel rather than left above it.
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
		const file = path.join(WIN32, `inno-big-${percent}.bmp`);
		writeBmp(file, width, height, panel(mark, width, height));
		console.log(`${path.relative(ROOT, file)} ${width}x${height}`);
	}

	const small = path.join(WIN32, 'inno-small.bmp');
	writeBmp(small, SMALL, SMALL, panel(mark, SMALL, SMALL));
	console.log(`${path.relative(ROOT, small)} ${SMALL}x${SMALL}`);
	}

	// ico-to-png -- was build/ico-to-png.mjs
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
	 * Usage: node build/branding.mjs ico-to-png <file.ico> <file.png>
	 */
	async function cmdIcoToPng(cli) {
	const fs = await import('node:fs');
	const [source, target] = cli;
	if (!source || !target) {
		process.stderr.write('usage: node build/branding.mjs ico-to-png <file.ico> <file.png>\n');
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
	}

	// patch-inno-updater -- was build/patch-inno-updater.mjs
	// PiCode: the updater says "Visual Studio Code".
	//
	// `inno_updater.exe` is VS Code's prebuilt updater: the installer invokes it while PiCode
	// restarts, it paints the little progress window, and it owns the error box when an update
	// cannot be installed. Its strings are compiled in, so the rebrand has to reach the binary.
	//
	// They live in two shapes, and both are branded here:
	//
	//   1. The DIALOG resource (RT_DIALOG, id 1001): the progress window's caption, its placeholder
	//      text ("Updating Visual Studio Code...", replaced at run time by the message the installer
	//      passes in - `{cm:UpdatingVisualStudioCode}`, which the .isl files translate as PiCode) and
	//      a msctls_progress32 bar. A DLGTEMPLATE stores those as UTF-16, NUL-terminated strings laid
	//      out one after another, so a shorter string would shift the pointsize that follows it and
	//      corrupt the dialog.
	//
	//   2. The program's own literals: this is a 32-bit Rust binary, so the failure box the owner
	//      actually sees ("Failed to install Visual Studio Code update. ..."), the caption it is
	//      shown under, "Visual Studio Code - Updater", "Visual Studio Code is updating...",
	//      "Please verify there are no Visual Studio Code processes still executing." and the
	//      `vscode-inno-updater-<pid>.log` prefix. They are ANSI bytes packed together with no
	//      separators, and a `&str` carries its byte length in the code, so a replacement that
	//      changed the length would make the program read a different slice.
	//
	// Every replacement therefore keeps the original byte length, right-padded with spaces. The
	// branded words go at the front and the padding lands at the end of each literal, where it is
	// invisible: behind a progress line, or as trailing space in a title bar. The failure box is the
	// exception - its caller appends the log file path, so its padding goes at the end of the last
	// sentence instead, before the closing blank line. A VERSIONINFO value would be length-prefixed
	// too, but that resource is rewritten by the build's rcedit stamp rather than here.
	//
	// Same length, same bytes, only the words change. Run from the repository root; re-run it
	// whenever the vendored binary is replaced. It is idempotent: already-patched strings are simply
	// not found again.
	async function cmdPatchInnoUpdater(cli) {
	const { readFileSync, writeFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const { dirname, join } = await import('node:path');
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const target = join(root, 'build', 'win32', 'inno_updater.exe');

	/**
	 * The UTF-16 dialog resource. Longest first: "Visual Studio Code - Updater" contains the bare
	 * brand and needs its own replacement so the line does not end up behind a run of spaces; the
	 * same is true of "Updating Visual Studio Code...".
	 */
	const dialogReplacements = [
		['Updating Visual Studio Code...', 'Updating PiCode...'],
		['Visual Studio Code - Updater', 'PiCode - Updater'],
		['Visual Studio Code', 'PiCode'],
	];

	/**
	 * The program's own ANSI literals. Longest first, and the full literal is always the needle:
	 * "Visual Studio Code" sits in the middle of the failure box and of the "processes still
	 * executing" line, and replacing only the brand would leave its twelve spare bytes as a gap in
	 * the middle of a sentence instead of at the end.
	 *
	 * The failure box is the one literal whose padding cannot go last: the caller appends the log file
	 * path to it, so trailing spaces would indent that path. Its twelve bytes go at the end of the
	 * last sentence instead, where the trailing spaces of a line are just as invisible and the path
	 * still starts at the left margin.
	 */
	const literalReplacements = [
		[
			'Failed to install Visual Studio Code update.\n\nUpdates may fail due to anti-virus software and/or runaway processes. Please try restarting your machine before attempting to update again.\n\nPlease read the log file for more information:\n\n',
			'Failed to install PiCode update.\n\nUpdates may fail due to anti-virus software and/or runaway processes. Please try restarting your machine before attempting to update again.\n\nPlease read the log file for more information:            \n\n',
		],
		[
			'\n\nPlease verify there are no Visual Studio Code processes still executing.',
			'\n\nPlease verify there are no PiCode processes still executing.',
		],
		['Visual Studio Code is updating...', 'PiCode is updating...'],
		['Visual Studio Code - Updater', 'PiCode - Updater'],
		['vscode-inno-updater-', 'picode-inno-updater-'],
		['Visual Studio Code', 'PiCode'],
	];

	/**
	 * Replaces every occurrence of each pair, in order, keeping the byte length. `encoding` is what
	 * the surrounding bytes are: the dialog resource is UTF-16, the literals are single bytes.
	 */
	function rebrand(buffer, replacements, encoding) {
		let patched = 0;

		for (const [from, to] of replacements) {
			if (to.length > from.length) {
				throw new Error(`"${to}" does not fit in "${from}" (${to.length} > ${from.length})`);
			}
			const needle = Buffer.from(from, encoding);
			const patch = Buffer.from(to.padEnd(from.length, ' '), encoding);
			if (needle.length !== patch.length) {
				throw new Error(`length mismatch for "${from}"`);
			}

			let at = buffer.indexOf(needle);
			while (at !== -1) {
				patch.copy(buffer, at);
				patched += 1;
				at = buffer.indexOf(needle, at + needle.length);
			}
		}

		return patched;
	}

	const buffer = readFileSync(target);
	const patched = rebrand(buffer, dialogReplacements, 'utf16le')
		+ rebrand(buffer, literalReplacements, 'latin1');

	if (patched === 0) {
		console.log('inno_updater.exe: already branded, nothing to do');
	} else {
		writeFileSync(target, buffer);
		console.log(`inno_updater.exe: rebranded ${patched} string(s)`);
	}
	}


const USAGE = `usage: node build/branding.mjs <brand-copy|make-inno-images|ico-to-png|patch-inno-updater>\n`;
const cli = process.argv.slice(2);

async function dispatch() {
	switch (cli[0]) {
		case 'brand-copy':
			return cmdBrandCopy(cli.slice(1));
		case 'make-inno-images':
			return cmdMakeInnoImages(cli.slice(1));
		case 'ico-to-png':
			return cmdIcoToPng(cli.slice(1));
		case 'patch-inno-updater':
			return cmdPatchInnoUpdater(cli.slice(1));
		default:
			process.stderr.write(USAGE);
			return process.exit(2);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await dispatch();
}
