/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import { gulp } from './lib/gulp/facade.ts';
import * as path from 'path';
import rcedit from 'rcedit';
import vfs from 'vinyl-fs';
import pkg from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import { getVersion } from './lib/getVersion.ts';
import * as task from './lib/gulp/task.ts';
import * as util from './lib/util.ts';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const repoPath = path.dirname(import.meta.dirname);
const commit = getVersion(repoPath);
// PiCode: an experimental build packs under its own name, so it never overwrites the tree a
// release was cut from. `PICODE_PACK_SUFFIX` is empty in every ordinary build — the path stays
// exactly what it always was — and `dev/build.sh` reads the same variable for its PACK_DIR.
const PACK_SUFFIX = process.env['PICODE_PACK_SUFFIX'] ?? '';
// PiCode: the install-side twin of PACK_SUFFIX. A build that packs beside the tree is normally
// installed beside the editor already on the machine, and that needs the installer to be a
// *different application* to Windows: with the release's AppId, Inno Setup finds the existing
// install through the registry and writes over its folder, and "Apps & features" shows one entry
// where there are two programs. `PICODE_INSTALLER_SUFFIX` (empty in every ordinary build) moves the
// three things that make an install recognisable together -- the folder it lands in, the name a
// person reads, and the AppId Windows knows it by. It is `dev/build.sh` that defaults it to the
// pack's own suffix; nothing in a release build sets either variable.
const INSTALLER_SUFFIX = process.env['PICODE_INSTALLER_SUFFIX'] ?? '';
// The AppIds of a side-by-side install, and only of one. The released application's identity stays
// where it has always been, in product.json (`win32x64UserAppId` and its siblings).
// The shape is Inno's: `{{GUID}` -- the doubled brace is an escaped one, and code.iss strips it back
// with `copy('{#IncompatibleTargetAppId}', 2, 38)` when it builds the uninstall key to look up.
const SIDE_BY_SIDE_APP_IDS = {
	'x64': '{{0C6D6F1E-0B4A-4E0F-9B0E-8C2F1F5B7A31}',
	'arm64': '{{5B1A9C3D-3E52-4F1B-8C47-2D9E6A0C4B22}'
};
// What a side-by-side build is *called*: "-experimental" is the folder naming's, and this is the
// human name the wizard, the Start menu shortcut and "Apps & features" show.
const sideBySideLabel = (suffix: string) =>
	suffix.replace(/^[^A-Za-z0-9]+/, '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
const buildPath = (arch: string) => path.join(path.dirname(repoPath), `PiCode-Win32-${arch}${PACK_SUFFIX}`);
const setupDir = (arch: string, target: string) => path.join(repoPath, '.build', `win32-${arch}`, `${target}-setup`);
const innoSetupPath = path.join(path.dirname(path.dirname(require.resolve('innosetup'))), 'bin', 'ISCC.exe');
// The Azure Pipelines machinery (build/azure-pipelines/) was removed with the
// test tree: PiCode builds no installers and never signs with ESRP, so the
// const that pointed at its win32 signing script went with it.

function packageInnoSetup(iss: string, options: { definitions?: Record<string, unknown> }, cb: (err?: Error | null) => void) {
	const definitions = options.definitions || {};

	if (process.argv.some(arg => arg === '--debug-inno')) {
		definitions['Debug'] = 'true';
	}

	if (process.argv.some(arg => arg === '--sign')) {
		definitions['Sign'] = 'true';
	}

	const keys = Object.keys(definitions);

	keys.forEach(key => assert(typeof definitions[key] === 'string', `Missing value for '${key}' in Inno Setup package step`));

	const defs = keys.map(key => `/d${key}=${definitions[key]}`);
	const args = [
		iss,
		...defs
	];

	cp.spawn(innoSetupPath, args, { stdio: ['ignore', 'inherit', 'inherit'] })
		.on('error', cb)
		.on('exit', code => {
			if (code === 0) {
				cb(null);
			} else {
				cb(new Error(`InnoSetup returned exit code: ${code}`));
			}
		});
}

function buildWin32Setup(arch: string, target: string): task.CallbackTask {
	if (target !== 'system' && target !== 'user') {
		throw new Error('Invalid setup target');
	}

	return (cb) => {
		const x64AppId = target === 'system' ? product.win32x64AppId : product.win32x64UserAppId;
		const arm64AppId = target === 'system' ? product.win32arm64AppId : product.win32arm64UserAppId;

		const sourcePath = buildPath(arch);
		const outputPath = setupDir(arch, target);
		fs.mkdirSync(outputPath, { recursive: true });

		// A side-by-side install: see PICODE_INSTALLER_SUFFIX above. Everything below that reads it is
		// the three things Windows needs to tell two installs apart, and nothing else changes -- the
		// executable, the profile and the mutex are still PiCode's, so the two builds share one
		// profile and one of them runs at a time.
		const sideBySide = INSTALLER_SUFFIX.length > 0;
		const installerLabel = sideBySide ? ` (${sideBySideLabel(INSTALLER_SUFFIX)})` : '';

		const quality = (product as typeof product & { quality?: string }).quality || 'dev';
		const useVersionedUpdate = (product as typeof product & { win32VersionedUpdate?: boolean })?.win32VersionedUpdate;
		const versionedResourcesFolder = useVersionedUpdate ? commit!.substring(0, 10) : '';
		const issPath = path.join(import.meta.dirname, 'win32', 'code.iss');
		const productJsonRelativePath = path.join(versionedResourcesFolder, 'resources/app/product.json');
		const originalProductJsonPath = path.join(sourcePath, productJsonRelativePath);
		const productJsonPath = path.join(outputPath, 'product.json');
		// Wrap the parse: a malformed built product.json should fail with a
		// message that names the file, not with a bare SyntaxError.
		let productJson: { [key: string]: any };
		try {
			productJson = JSON.parse(fs.readFileSync(originalProductJsonPath, 'utf8'));
		} catch (err) {
			throw new Error(`Failed to parse ${originalProductJsonPath}: ${err instanceof Error ? err.message : err}`);
		}
		productJson['target'] = target;

		const definitions: Record<string, unknown> = {
			NameLong: product.nameLong + installerLabel,
			NameShort: product.nameShort,
			// The release's folder is the product name alone. A side-by-side one is named after the
			// folder it was packed into (`PiCode-Win32-<arch><suffix>`), so the editor on the disk and
			// the editor in the Start menu are recognisably the same build.
			DirName: sideBySide ? `${product.win32DirName}-win32-${arch}${INSTALLER_SUFFIX}` : product.win32DirName,
			Version: pkg.version,
			RawVersion: pkg.version.replace(/-\w+$/, ''),
			Commit: commit,
			NameVersion: product.win32NameVersion + (target === 'user' ? ' (User)' : '') + installerLabel,
			ExeBasename: product.nameShort,
			RegValueName: product.win32RegValueName,
			ShellNameShort: product.win32ShellNameShort,
			AppMutex: product.win32MutexName,
			TunnelMutex: product.win32TunnelMutex,
			TunnelServiceMutex: product.win32TunnelServiceMutex,
			TunnelApplicationName: product.tunnelApplicationName,
			ApplicationName: product.applicationName,
			Arch: arch,
			AppId: sideBySide
				? { 'x64': SIDE_BY_SIDE_APP_IDS.x64, 'arm64': SIDE_BY_SIDE_APP_IDS.arm64 }[arch]
				: { 'x64': x64AppId, 'arm64': arm64AppId }[arch],
			IncompatibleTargetAppId: { 'x64': product.win32x64AppId, 'arm64': product.win32arm64AppId }[arch],
			AppUserId: product.win32AppUserModelId,
			ArchitecturesAllowed: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			ArchitecturesInstallIn64BitMode: { 'x64': 'x64', 'arm64': 'arm64' }[arch],
			SourceDir: sourcePath,
			RepoDir: repoPath,
			OutputDir: outputPath,
			InstallTarget: target,
			ProductJsonRelativePath: productJsonRelativePath,
			ProductJsonPath: productJsonPath,
			VersionedResourcesFolder: versionedResourcesFolder,
			Quality: quality
		};

		// if (quality === 'stable' || quality === 'insider') {
		// 	definitions['AppxPackage'] = `${product.applicationName.replaceAll('-', '_')}_${arch}.appx`;
		// 	definitions['AppxPackageDll'] = `${product.applicationName.replaceAll('-', '_')}_explorer_command_${arch}.dll`;
		// 	definitions['AppxPackageName'] = `${product.win32AppUserModelId}`;
		// 	const ctxMenu = (product as { win32ContextMenu?: Record<string, { clsid: string }> }).win32ContextMenu;
		// 	if (ctxMenu && ctxMenu[arch]) {
		// 		definitions['FileExplorerContextMenuCLSID'] = ctxMenu[arch].clsid;
		// 	}
		// }

		fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\t'));

		packageInnoSetup(issPath, { definitions }, cb as (err?: Error | null) => void);
	};
}

function defineWin32SetupTasks(arch: string, target: string) {
	const cleanTask = util.rimraf(setupDir(arch, target));
	task.task(task.define(`vscode-win32-${arch}-${target}-setup`, task.series(cleanTask, buildWin32Setup(arch, target))));
}

defineWin32SetupTasks('x64', 'system');
defineWin32SetupTasks('arm64', 'system');
defineWin32SetupTasks('x64', 'user');
defineWin32SetupTasks('arm64', 'user');

function copyInnoUpdater(arch: string) {
	return () => {
		return gulp.src('build/win32/{inno_updater.exe,vcruntime140.dll}', { base: 'build/win32' })
			.pipe(vfs.dest(path.join(buildPath(arch), 'tools')));
	};
}

// PiCode: the updater's icon **and** its version resource, and this is the only place that can do
// it. `patchWin32DependenciesTask` (build/gulpfile.vscode.ts) stamps `**/tools/inno_updater.exe`
// along with the rest of the pack, but the file is not in the pack yet when it runs: this task is
// what copies it there, and it runs a phase later (measured 2026-10-09: packing finished at
// 17:45:41, the copy ran at 17:46:32, and the packed file still read FileDescription "VSCode Inno
// Updater", CompanyName "Microsoft Corporation" and ProductVersion "acda8ead" -- VS Code's commit).
// The fields and their values are the ones that stamp writes, read from the same two files it reads
// them from, so the updater ends up looking like the rest of the pack.
function brandInnoUpdater(executablePath: string, basename: string): task.CallbackTask {
	return cb => {
		const icon = path.join(repoPath, 'resources', 'win32', 'code.ico');
		rcedit(executablePath, {
			icon,
			'file-version': pkg.version.replace(/-.*$/, ''),
			'version-string': {
				'CompanyName': 'TomasPlatero',
				'FileDescription': product.nameLong,
				'FileVersion': pkg.version,
				'InternalName': basename,
				'LegalCopyright': 'Copyright (C) 2026 TomasPlatero. All rights reserved',
				'OriginalFilename': basename,
				'ProductName': product.nameLong,
				'ProductVersion': pkg.version,
			}
		}, cb);
	};
}

task.task(task.define('vscode-win32-x64-inno-updater', task.series(copyInnoUpdater('x64'), brandInnoUpdater(path.join(buildPath('x64'), 'tools', 'inno_updater.exe'), 'inno_updater.exe'))));
task.task(task.define('vscode-win32-arm64-inno-updater', task.series(copyInnoUpdater('arm64'), brandInnoUpdater(path.join(buildPath('arm64'), 'tools', 'inno_updater.exe'), 'inno_updater.exe'))));
