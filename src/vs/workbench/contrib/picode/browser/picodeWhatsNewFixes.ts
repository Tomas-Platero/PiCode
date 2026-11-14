/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * One thing a release fixed, written for the person using PiCode. The text is Markdown (a bold
 * lead, then one or two sentences) and is translated with the rest of the editor, unlike the
 * release page, which is only in English.
 */
export interface IWhatsNewFix {
	/** The version that first carries the fix (`2.0.1`). */
	readonly since: string;
	readonly text: string;
}

/**
 * What each release fixed, newest first. A fix release adds its entries here with `since` set to its
 * own version; the "Bugs fixed" page shows all of the current line (2.0.x), so a person who skipped
 * a fix release still sees it.
 */
export function whatsNewFixes(): readonly IWhatsNewFix[] {
	return [
		{
			since: '2.2.7',
			text: localize('picodeWhatsNew.fix.engineOrphan', "**The memory engine closes with PiCode.** When PiCode was opened and closed quickly, the memory engine could stay running on its own and keep files busy. Now the last window to close always stops the engine PiCode started, and so does PiCode itself when it quits."),
		},
		{
			since: '2.2.7',
			text: localize('picodeWhatsNew.fix.statusTidy', "**Status is tidier.** The cards line up in rows, an Updates card no longer shows up empty, and every colour follows your theme."),
		},
		{
			since: '2.2.7',
			text: localize('picodeWhatsNew.fix.updateNotice', "**The update notice speaks your language.** It said \"memory engine\" in English; it now uses your language."),
		},
		{
			since: '2.2.4',
			text: localize('picodeWhatsNew.fix.contextEditor', "**Context is also in the Editor layout.** The PiCode panel now opens with Context, drawn the same as in Status, and Compact session is a single button that explains itself when you point at it."),
		},
		{
			since: '2.2.3',
			text: localize('picodeWhatsNew.fix.updateRestart', "**Updates install when PiCode restarts again.** The new version was downloaded but the switch never happened, because the helper that lets chats message each other kept your profile busy. PiCode now closes it first, and the installer waits for the profile to be free."),
		},
		{
			since: '2.0.4',
			text: localize('picodeWhatsNew.fix.lostFolder', "**Conversations whose folder is gone now ask first.** Opening one lets you continue in the folder that is open or copy the conversation into it, instead of carrying on silently."),
		},
		{
			since: '2.0.4',
			text: localize('picodeWhatsNew.fix.cacheCost', "**The cost in Status counts the cache warm-ups.** What pi spends between turns to keep the prompt cache warm is now added, so the total is no longer too low."),
		},
		{
			since: '2.0.3',
			text: localize('picodeWhatsNew.fix.language', "**What's New now speaks your language.** The list of fixes is translated, and the window keeps the news of this version line together with every fix since."),
		},
		{
			since: '2.0.2',
			text: localize('picodeWhatsNew.fix.whatsNew', "**What's New opens after every update.** Updates that only fix things now show their fixes here, and the window no longer opens blank."),
		},
		{
			since: '2.0.2',
			text: localize('picodeWhatsNew.fix.updateAccess', "**Updating no longer stops at \"Access denied\".** The memory engine that PiCode carries now closes right before the update replaces its folder."),
		},
		{
			since: '2.0.1',
			text: localize('picodeWhatsNew.fix.jira', "**Connecting Jira no longer depends on your browser.** Some browsers never opened PiCode again after you agreed on Atlassian's page. Now a PiCode page shows which account gets the connection, you confirm it there, and the editor notices by itself."),
		},
	];
}
