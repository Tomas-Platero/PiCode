/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ILogService } from '../../platform/log/common/log.js';

/**
 * The one file that says whether PiCode's setup already ran, and what it decided.
 *
 * Kept away from the window and from Electron on purpose: this is the only state the start-up
 * path reads before deciding to do anything, so being able to run it on its own is what makes
 * "a first run shows the setup, every later run does not" something that can be checked rather
 * than assumed.
 *
 * The file lives next to the installation's data — `data/onboarding.json` in a portable install,
 * the user data directory otherwise — so it is **one answer per installation**, shared by every
 * window and every profile on it. That is the intent: the setup is about this copy of PiCode,
 * not about who is using it.
 */

/** The setup's own revision. Bump it to make the setup run again after a change in its flow. */
export const ONBOARDING_VERSION = 1;

/** The file's name, next to the installation's data. */
export const ONBOARDING_FLAG_FILE = 'onboarding.json';

/** What `onboarding.json` holds. */
export interface OnboardingFlag {
	readonly completed: boolean;
	readonly onboardingVersion?: number;
	readonly productVersion?: string;
}

/**
 * The flag as recorded, or `undefined` when nothing was ever recorded.
 *
 * A missing file is a first run. An unreadable one is treated the same way, which is harmless:
 * the worst case is one extra setup that is skipped in a click.
 */
export function readOnboardingFlag(dataDir: string): OnboardingFlag | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(dataDir, ONBOARDING_FLAG_FILE), 'utf8'));
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			return undefined;
		}
		const value = raw as Record<string, unknown>;
		return {
			completed: value['completed'] === true,
			onboardingVersion: typeof value['onboardingVersion'] === 'number' ? value['onboardingVersion'] : undefined,
			productVersion: typeof value['productVersion'] === 'string' ? value['productVersion'] : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * Records that the setup is done.
 *
 * Best effort by design: a read-only install still opens its editor, and a setup that could not
 * write one small file has not failed at anything the owner asked for.
 */
export function writeOnboardingFlag(dataDir: string, productVersion: string | undefined, logService?: ILogService): void {
	try {
		mkdirSync(dataDir, { recursive: true });
		const flag: OnboardingFlag = { completed: true, onboardingVersion: ONBOARDING_VERSION, productVersion };
		writeFileSync(join(dataDir, ONBOARDING_FLAG_FILE), `${JSON.stringify(flag, undefined, '\t')}\n`);
	} catch (error) {
		logService?.warn('[picode-onboarding] the setup could not record that it is done', error);
	}
}

/** The major version of the product, which is what decides an upgrade-run. */
export function majorVersion(version: string | undefined): string {
	return typeof version === 'string' ? (version.split('.')[0] ?? '') : '';
}

/**
 * Why the setup should run now, or `undefined` when it should not.
 *
 * - No flag at all → first run.
 * - Flag with a different `onboardingVersion` → the flow itself changed, so it runs again and
 *   preselects what is already configured.
 * - Flag from a different **major** version → the upgrade run: same page, nothing overwritten.
 * - Anything else → nothing happens: no window is created and no process is spawned.
 */
export function onboardingReason(flag: OnboardingFlag | undefined, productVersion: string | undefined): 'first-run' | 'update' | undefined {
	if (flag === undefined || flag.completed !== true) {
		return 'first-run';
	}
	if (flag.onboardingVersion !== ONBOARDING_VERSION) {
		return 'update';
	}
	if (majorVersion(flag.productVersion) !== majorVersion(productVersion)) {
		return 'update';
	}
	return undefined;
}
