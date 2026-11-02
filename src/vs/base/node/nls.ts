/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from '../common/path.js';
import { promises } from 'fs';
import { mark } from '../common/performance.js';
import { ILanguagePacks, INLSConfiguration } from '../../nls.js';
import { Promises } from './pfs.js';

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	mark('code/willGenerateNls');

	if (
		process.env['VSCODE_DEV'] ||
		userLocale === 'pseudo' ||
		userLocale.startsWith('en') ||
		!commit ||
		!userDataPath
	) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		const languagePacks = await getLanguagePackConfigurations(userDataPath);
		if (!languagePacks) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
		if (!resolvedLanguage) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		const languagePack = languagePacks[resolvedLanguage];
		const mainLanguagePackPath = languagePack?.translations?.['vscode'];
		if (
			!languagePack ||
			typeof languagePack.hash !== 'string' ||
			!languagePack.translations ||
			typeof mainLanguagePackPath !== 'string' ||
			!(await Promises.exists(mainLanguagePackPath))
		) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}

		// PiCode's own strings are not in any marketplace language pack, so each shipped
		// language adds an overlay (flat `key -> text`) that wins over the pack. Its hash goes
		// into the cache id so editing the overlay never serves a stale merged file.
		const picodeOverlay = await readPicodeOverlay(nlsMetadataPath, resolvedLanguage);
		const languagePackId = `${languagePack.hash}${picodeOverlay.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = join(userDataPath, 'clp', languagePackId);
		const commitLanguagePackCachePath = join(globalLanguagePackCachePath, commit);
		const languagePackMessagesFile = join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = join(globalLanguagePackCachePath, 'corrupted.info');

		if (await Promises.exists(languagePackCorruptMarkerFile)) {
			await promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (await Promises.exists(languagePackMessagesFile)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			mark('code/didGenerateNls');
			return result;
		}

		const [
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata
		]:
			[Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]
			//      ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				promises.readFile(join(nlsMetadataPath, 'nls.keys.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(join(nlsMetadataPath, 'nls.messages.json'), 'utf-8').then(content => JSON.parse(content)),
				promises.readFile(mainLanguagePackPath, 'utf-8').then(content => JSON.parse(content)),
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			for (const nlsKey of nlsKeys) {
				// `picode*` keys are unique on their own; strings PiCode rewrote inside upstream modules are scoped by module.
				nlsResult.push(picodeOverlay.messages[nlsKey] || picodeOverlay.messages[`${moduleId}#${nlsKey}`] || moduleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await promises.mkdir(commitLanguagePackCachePath, { recursive: true });

		await Promise.all([
			promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations), 'utf-8')
		]);

		mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

interface IPicodeOverlay {
	readonly messages: Record<string, string>;
	/** Empty when there is no overlay for the language. */
	readonly hash: string;
}

/**
 * Reads `picode/l10n/<language>.json`, falling back from `pt-br` to `pt`. A missing or broken
 * file just means PiCode's own strings stay in English.
 */
async function readPicodeOverlay(nlsMetadataPath: string, language: string): Promise<IPicodeOverlay> {
	const directory = join(nlsMetadataPath, 'vs', 'workbench', 'contrib', 'picode', 'l10n');
	for (let candidate = language; candidate;) {
		try {
			const content = await promises.readFile(join(directory, `${candidate}.json`), 'utf-8');
			const messages = JSON.parse(content) as Record<string, string>;
			let hash = 0;
			for (let i = 0; i < content.length; i++) {
				hash = (hash * 31 + content.charCodeAt(i)) | 0;
			}
			return { messages, hash: `-${(hash >>> 0).toString(16)}` };
		} catch {
			const index = candidate.lastIndexOf('-');
			candidate = index > 0 ? candidate.substring(0, index) : '';
		}
	}
	return { messages: {}, hash: '' };
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string): Promise<ILanguagePacks | undefined> {
	const configFile = join(userDataPath, 'languagepacks.json');
	try {
		return JSON.parse(await promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		return undefined; // Do nothing. If we can't read the file we have no language pack config.
	}
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

function touch(path: string): Promise<void> {
	const date = new Date();

	return promises.utimes(path, date, date);
}

//#endregion
