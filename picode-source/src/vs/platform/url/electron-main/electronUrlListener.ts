/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, Event as ElectronEvent } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import { disposableTimeout } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IURLService } from '../common/url.js';
import { IProtocolUrl } from './url.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';

/**
 * A listener for URLs that are opened from the OS and handled by VSCode.
 * Depending on the platform, this works differently:
 * - Windows: we use `app.setAsDefaultProtocolClient()` to register VSCode with the OS
 *            and additionally add the `open-url` command line argument to identify.
 * - macOS:   we rely on `app.on('open-url')` to be called by the OS
 * - Linux:   we have a special shortcut installed (`resources/linux/code-url-handler.desktop`)
 *            that calls VSCode with the `open-url` command line argument
 *            (https://github.com/microsoft/vscode/pull/56727)
 */
export class ElectronURLListener extends Disposable {

	private uris: IProtocolUrl[] = [];
	private retryCount = 0;

	constructor(
		initialProtocolUrls: IProtocolUrl[] | undefined,
		private readonly urlService: IURLService,
		windowsMainService: IWindowsMainService,
		environmentMainService: IEnvironmentMainService,
		productService: IProductService,
		private readonly logService: ILogService
	) {
		super();

		if (initialProtocolUrls) {
			logService.trace('ElectronURLListener initialUrisToHandle:', initialProtocolUrls.map(url => url.originalUrl));

			// the initial set of URIs we need to handle once the window is ready
			this.uris = initialProtocolUrls;
		}

		// Windows: install as protocol handler
		// Skip in portable mode: the registered command wouldn't preserve
		// portable mode settings, causing issues with OAuth flows.
		if (isWindows && !environmentMainService.isPortable) {
			if (environmentMainService.isBuilt) {
				// Built: register the executable directly. Electron quotes argument
				// values itself when writing the registry entry — do not pre-quote
				// them here, nested quotes break the registration.
				app.setAsDefaultProtocolClient(productService.urlProtocol, process.execPath, ['--open-url', '--']);
			} else if (process.env['VSCODE_DEV']) {
				// Development (launched via scripts/code.bat): the process spawned by
				// the OS does NOT inherit the dev environment (VSCODE_DEV / NODE_ENV),
				// so it computes a different user data dir and IPC handle and starts a
				// separate instance instead of handing the URL to the running editor.
				// Register a PowerShell launcher that re-creates the dev environment
				// first. PowerShell (NOT cmd) is used deliberately: cmd /c mangles
				// quoted URLs containing '&' (it splits them as command separators),
				// which fragments OAuth callback URLs.
				const launcherPath = join(environmentMainService.appRoot, 'picode-url-handler.ps1');
				const launcherContents = [
					"$env:VSCODE_DEV = '1'",
					"$env:NODE_ENV = 'development'",
					`& '${process.execPath}' '${environmentMainService.appRoot}' --open-url -- @args`,
					''
				].join('\r\n');
				try {
					fs.writeFileSync(launcherPath, launcherContents, { flag: 'w' });
					const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
					const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
					app.setAsDefaultProtocolClient(productService.urlProtocol, powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath]);
				} catch (error) {
					// Fall back to the direct registration; protocol URLs will open a
					// separate instance in this configuration, but the app still works.
					this.logService.warn('Failed to write the development protocol launcher; registering the executable directly.', error);
					app.setAsDefaultProtocolClient(productService.urlProtocol, process.execPath, [environmentMainService.appRoot, '--open-url', '--']);
				}
			} else {
				// Dev binary launched without the dev environment (standalone).
				app.setAsDefaultProtocolClient(productService.urlProtocol, process.execPath, [environmentMainService.appRoot, '--open-url', '--']);
			}
		}

		// macOS: listen to `open-url` events from here on to handle
		const onOpenElectronUrl = Event.map(
			Event.fromNodeEventEmitter(app, 'open-url', (event: ElectronEvent, url: string) => ({ event, url })),
			({ event, url }) => {
				event.preventDefault(); // always prevent default and return the url as string

				return url;
			});

		this._register(onOpenElectronUrl(url => {
			const uri = this.uriFromRawUrl(url);
			if (!uri) {
				return;
			}

			this.urlService.open(uri, { originalUrl: url });
		}));

		// Send initial links to the window once it has loaded
		const isWindowReady = windowsMainService.getWindows()
			.filter(window => window.isReady)
			.length > 0;

		if (isWindowReady) {
			logService.trace('ElectronURLListener: window is ready to handle URLs');

			this.flush();
		} else {
			logService.trace('ElectronURLListener: waiting for window to be ready to handle URLs...');

			this._register(Event.once(windowsMainService.onDidSignalReadyWindow)(() => this.flush()));
		}
	}

	private uriFromRawUrl(url: string): URI | undefined {
		try {
			return URI.parse(url);
		} catch {
			return undefined;
		}
	}

	private async flush(): Promise<void> {
		if (this.retryCount++ > 10) {
			this.logService.trace('ElectronURLListener#flush(): giving up after 10 retries');

			return;
		}

		this.logService.trace('ElectronURLListener#flush(): flushing URLs');

		const uris: IProtocolUrl[] = [];

		for (const obj of this.uris) {
			const handled = await this.urlService.open(obj.uri, { originalUrl: obj.originalUrl });
			if (handled) {
				this.logService.trace('ElectronURLListener#flush(): URL was handled', obj.originalUrl);
			} else {
				this.logService.trace('ElectronURLListener#flush(): URL was not yet handled', obj.originalUrl);

				uris.push(obj);
			}
		}

		if (uris.length === 0) {
			return;
		}

		this.uris = uris;
		disposableTimeout(() => this.flush(), 500, this._store);
	}
}
