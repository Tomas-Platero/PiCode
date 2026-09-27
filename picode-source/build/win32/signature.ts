import * as cp from 'child_process';
import { promises as fs } from 'node:fs';

export async function stripAuthenticodeSignature(filePath: string): Promise<void> {
	const signPath = await getSigntoolPath()
	// ESRP's `signtool /as` (append) fails with 0x800700C1 on PEs whose existing
	// Authenticode signature was invalidated by rcedit. Strip cleanly first so
	// rcedit operates on an unsigned PE.
	if (!await hasAuthenticodeSignature(filePath, signPath)) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const proc = cp.spawn(signPath, ['remove', '/s', filePath]);
		let out = '';
		proc.stdout?.on('data', chunk => out += chunk.toString());
		proc.stderr?.on('data', chunk => out += chunk.toString());
		proc.on('error', reject);
		proc.on('exit', code => {
			if (code === 0) {
				resolve();
			} else {
				process.stderr.write(out);
				reject(new Error(`signtool remove /s failed for ${filePath} (exit ${code})`));
			}
		});
	});
}

async function getSigntoolPath(): Promise<string> {
    const windowsKitsFolder = 'C:/Program Files (x86)/Windows Kits/10/bin/';
    const folders = await fs.readdir(windowsKitsFolder);
    let fileName = '';
    let maxVersion = 0;
    for (const folder of folders) {
        if (!folder.endsWith('.0')) {
            continue;
        }
        const folderVersion = parseInt(folder.replace(/\./g,''));
        if (folderVersion > maxVersion) {
            const signtoolFilename = `${windowsKitsFolder}${folder}/x64/signtool.exe`;
            try {
                const stat = await fs.stat(signtoolFilename);
                if (stat.isFile()) {
                    fileName = signtoolFilename;
                    maxVersion = folderVersion;
                }
            }
            catch {
                console.warn('Skipping %s due to error.', signtoolFilename);
            }
        }
    }
    if(fileName == '') {
        throw new Error('Unable to find signtool.exe in ' + windowsKitsFolder);
    }

    console.log(`Signtool location is ${fileName}.`);

    return fileName;
}

function hasAuthenticodeSignature(filePath: string, signPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const proc = cp.spawn(signPath, ['verify', '/pa', filePath]);
		proc.on('error', reject);
		proc.on('exit', code => resolve(code === 0));
	});
}