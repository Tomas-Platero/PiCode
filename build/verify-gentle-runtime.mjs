import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, architecture] = process.argv.slice(2);
const expected = readFileSync(new URL('./distribution/gentle-ai.json', import.meta.url));

try {
	const packaged = readFileSync(join(directory, 'pin.json'));
	if (!expected.equals(packaged)) {
		throw new Error('Packaged version pin differs from the build pin');
	}
	const { gentleAiVersion, goModule, goModuleChecksum } = JSON.parse(expected);
	const versionDirectory = join(directory, `v${gentleAiVersion}`);
	const manifestPath = join(versionDirectory, 'integrity.json');
	const executablePath = join(versionDirectory, 'gentle-ai.exe');
	if (!lstatSync(executablePath).isFile() || !lstatSync(manifestPath).isFile()) {
		throw new Error('Expected a regular executable and manifest');
	}
	const binary = readFileSync(executablePath);
	const machine = { x64: 0x8664, arm64: 0xaa64 }[architecture];
	const header = binary.readUInt32LE(0x3c);
	if (machine === undefined || binary.readUInt16LE(0) !== 0x5a4d
		|| binary.readUInt32LE(header) !== 0x4550 || binary.readUInt16LE(header + 4) !== machine) {
		throw new Error('Expected a Windows executable for the target architecture');
	}
	const manifestText = readFileSync(manifestPath, 'utf8');
	const { goVersion } = JSON.parse(manifestText);
	const version = /^go(\d+)\.(\d+)\.(\d+)$/.exec(goVersion);
	const [major, minor, patch] = version?.slice(1).map(Number) ?? [];
	const supportedGo = major > 1 || major === 1 && (minor > 25 || minor === 25 && patch >= 10);
	const manifest = {
		version: gentleAiVersion,
		method: 'go-sumdb-source-build',
		package: `${goModule}/cmd/gentle-ai`,
		module: goModule,
		tag: `v${gentleAiVersion}`,
		architecture,
		binarySha256: createHash('sha256').update(binary).digest('hex'),
		moduleChecksum: goModuleChecksum,
		goVersion,
		goos: 'windows',
		goarch: architecture === 'x64' ? 'amd64' : 'arm64',
		buildMode: 'exe',
		compiler: 'gc',
		cgoEnabled: '0',
	};
	if (!supportedGo || manifestText !== `${JSON.stringify(manifest)}\n`) {
		throw new Error('The executable does not match its version, architecture or integrity manifest');
	}
} catch (error) {
	console.error(`Gentle AI verification failed: ${error.message}`);
	process.exitCode = 1;
}
