/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const supportedPackage = '5.0.0';
const supportedRuntime = '5.0.0';
const upstreamDigest = 'd0d8dbcc825421d6d3ab38c512fd01278a7368843976d7ee1311f491964056d4';
const adaptedDigest = '3fa6ac71a480c5fc6dc622b05d44809554ee980968a0c10e3e5a9a4d1a8d9556';
const platformLine = '\tconst platform = options.platform ?? process.platform;';
const overrideLine = '\tconst override = resolveGentleAiDevBinaryOverride(environment, platform);';
export const GENTLE_REVIEW_SETTING = 'picode.review.enabled';
export const GENTLE_REVIEW_ENV = 'PICODE_GENTLE_REVIEW_ENABLED';

/** An unprepared package with its own runtime must not start a native process for PiCode. */
export function hasUnmanagedGentleRuntime(profile: string): boolean {
	return Boolean(process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY)
		|| lstatSync(path.join(profile, 'gentle-ai', 'dev-binary.json'), { throwIfNoEntry: false }) !== undefined
		|| lstatSync(path.join(profile, 'npm', 'node_modules', 'gentle-pi', '.gentle-ai'), { throwIfNoEntry: false }) !== undefined;
}

function sha256(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * Adapt the pinned package's process boundary. Its controller and reviewer relay share this
 * helper, and the package still verifies its own executable and integrity manifest.
 */
export function isolateGentleReviewSource(source: string): string | undefined {
	if (sha256(source) !== upstreamDigest) {
		return undefined;
	}
	const functionStart = source.indexOf('export function gentleAiIsolationEnv(');
	const boundary = source.indexOf(platformLine, functionStart) + platformLine.length;
	const isolated = `
	const profile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
	for (let directory = profile; directory !== dirname(directory); directory = dirname(directory)) {
		if (!lstatSync(directory).isDirectory()) throw new Error("PiCode review requires an unlinked profile path");
	}
	for (const name of ["gentle-review", "gentle-ai"]) {
		const entry = lstatSync(join(profile, name), { throwIfNoEntry: false });
		if (entry && !entry.isDirectory()) throw new Error("PiCode review requires a local profile directory");
	}
	const state = lstatSync(join(profile, "gentle-review", "state.json"), { throwIfNoEntry: false });
	if (state && !state.isFile()) throw new Error("PiCode review requires a local state file");
	const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GENTLE_AI_")));
	return {
		...childEnv,
		GENTLE_AI_HOME: join(profile, "gentle-review"),
		GENTLE_AI_PI_CONFIG_DIR: join(profile, "gentle-ai"),
		GENTLE_PI_CONFIG_HOME: join(profile, "gentle-ai"),
		GENTLE_AI_NO_SELF_UPDATE: "1",
		GENTLE_AI_TELEMETRY: "0",
		PI_CODING_AGENT_DIR: profile,
	};
`;
	const tail = source.indexOf('\nfunction standaloneGentleAiEnv', boundary);
	const end = source.lastIndexOf('\n}', tail);
	const adapted = source.slice(0, boundary - platformLine.length) + isolated + source.slice(end);
	return adapted.replace(overrideLine, `\tif (process.env["${GENTLE_REVIEW_ENV}"] !== "1") {
		throw new PackageLocalGentleAiBinaryMissingError(gentleAiBinaryPath(packageRoot, platform));
	}
	const override = undefined as GentleAiDevBinaryOverride | undefined;`);
}

function replaceFile(file: string, contents: Buffer | string): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents, { flag: 'wx' });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function realDirectory(directory: string): boolean {
	return lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** Stage the verified Windows bundle only in PiCode's matching internal npm package. */
export function prepareGentleReview(runtimeRoot: string, profile: string): boolean {
	const distribution = path.resolve(runtimeRoot, '..', 'gentle-ai');
	const pinFile = path.join(distribution, 'pin.json');
	if (!lstatSync(pinFile, { throwIfNoEntry: false })?.isFile()) {
		return false;
	}
	const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
	if (pin.gentlePiVersion !== supportedPackage || pin.gentleAiVersion !== supportedRuntime) {
		return false;
	}
	const npm = path.join(profile, 'npm');
	const modules = path.join(npm, 'node_modules');
	const packageDir = path.join(modules, 'gentle-pi');
	const lib = path.join(packageDir, 'lib');
	if (![profile, npm, modules, packageDir, lib].every(realDirectory)) {
		return false;
	}
	const packageManifest = path.join(packageDir, 'package.json');
	const sourceFile = path.join(lib, 'gentle-ai-binary.ts');
	if (![packageManifest, sourceFile].every(file => lstatSync(file, { throwIfNoEntry: false })?.isFile())
		|| JSON.parse(readFileSync(packageManifest, 'utf8')).version !== supportedPackage) {
		return false;
	}
	for (const directory of ['gentle-review', 'gentle-ai']) {
		const entry = lstatSync(path.join(profile, directory), { throwIfNoEntry: false });
		if (entry && !entry.isDirectory()) {
			return false;
		}
	}
	const runtime = path.join(distribution, `v${supportedRuntime}`);
	const executable = readFileSync(path.join(runtime, 'gentle-ai.exe'));
	const manifest = readFileSync(path.join(runtime, 'integrity.json'));
	const provenance = JSON.parse(manifest.toString('utf8'));
	if (provenance.version !== supportedRuntime || provenance.architecture !== process.arch || provenance.binarySha256 !== sha256(executable)) {
		throw new Error('Invalid bundled Gentle AI runtime');
	}
	const source = readFileSync(sourceFile, 'utf8');
	const adapted = isolateGentleReviewSource(source);
	const target = path.join(packageDir, '.gentle-ai');
	const version = path.join(target, `v${supportedRuntime}`);
	// An already prepared installation needs no rewrite. Never activate a package whose
	// installed process-boundary module we cannot recognize.
	if (adapted === undefined && sha256(source) !== adaptedDigest) {
		return false;
	}
	for (const directory of [target, version]) {
		if (!lstatSync(directory, { throwIfNoEntry: false })) {
			mkdirSync(directory);
		}
		if (!realDirectory(directory)) {
			throw new Error('Gentle AI runtime directory is not a regular directory');
		}
	}
	if (adapted !== undefined) {
		replaceFile(sourceFile, adapted);
	}
	for (const [name, contents] of [['integrity.json', manifest], ['gentle-ai.exe', executable]] as const) {
		const file = path.join(version, name);
		if (!lstatSync(file, { throwIfNoEntry: false })?.isFile() || !readFileSync(file).equals(contents)) {
			replaceFile(file, contents);
		}
	}
	return true;
}
