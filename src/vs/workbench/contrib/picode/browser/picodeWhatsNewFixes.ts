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
			since: '2.4.5',
			text: localize('picodeWhatsNew.fix.fasterStart', "**pi gets going much sooner.** Opening a window used to get pi ready up to three times over, and everything froze while it did. Now it gets ready once, and your model list and slash commands appear right away."),
		},
		{
			since: '2.4.5',
			text: localize('picodeWhatsNew.fix.updateMemoryLock', "**Updates no longer get stuck on \"Access denied\".** If an update installs when you close PiCode, the memory helper now closes first, so the installer can finish."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.autoEverything', "**Automatic really means everything.** PiCode, pi, its packages and your extensions now update on their own, quietly, without a single console window popping up. And never in the middle of an answer."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.memoryInPlace', "**Check your memory right where you are.** The check now answers on the same page, with a clear verdict and only what needs a look."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.profilesInAgents', "**Profiles live with your agents.** Choosing the model each agent works with is now the first tab of Agents, right next to your own agents."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.shortcutList', "**All your shortcuts at a glance.** The Keyboard page lists every shortcut, with a search box to find one fast."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.moreAccessibility', "**More ways to make PiCode comfortable.** Underlined links, a thicker cursor, dimmed panels, smooth scrolling and more, in Accessibility."),
		},
		{
			since: '2.4.4',
			text: localize('picodeWhatsNew.fix.noDeadEnds', "**No dead ends.** Using your own pi is greyed out until there's one on your computer, and it tells you why."),
		},
		{
			since: '2.4.3',
			text: localize('picodeWhatsNew.fix.settingsLabels.warm', "**Settings that speak your language.** Options are named the way you already know them from other editors, so there's nothing new to learn."),
		},
		{
			since: '2.4.3',
			text: localize('picodeWhatsNew.fix.editorStatus.warm', "**Status in the Editor layout too.** Everything at a glance, the same panel whichever layout you prefer."),
		},
		{
			since: '2.4.2',
			text: localize('picodeWhatsNew.fix.piProblems.warm', "**pi lets you know when something's off.** If an extension can't load or a saved chat can't get its model back, you'll see a short note in the chat instead of wondering what happened."),
		},
		{
			since: '2.4.2',
			text: localize('picodeWhatsNew.fix.thinkingLevels.warm', "**Only the options your model really has.** If a model can't think at a certain level, that choice is greyed out, so what you pick is what you get."),
		},
		{
			since: '2.4.2',
			text: localize('picodeWhatsNew.fix.toolsReal.warm', "**Tools shows pi's real tools.** Each one has its own switch, and turning it off really turns it off."),
		},
		{
			since: '2.4.2',
			text: localize('picodeWhatsNew.fix.packageInstalls.warm', "**No more endless waiting.** Installing a package that needs a password now tells you clearly instead of hanging."),
		},
		{
			since: '2.4.1',
			text: localize('picodeWhatsNew.fix.shareUsage.warm', "**You decide whether to help.** Sharing anonymous counts to improve PiCode is your choice, and you can change it anytime in your account. Your code and chats always stay yours."),
		},
		{
			since: '2.4.0',
			text: localize('picodeWhatsNew.fix.keysStayHome.warm', "**Your keys stay with you.** Your provider and server keys never travel to the cloud; everything else still syncs."),
		},
		{
			since: '2.3.2',
			text: localize('picodeWhatsNew.fix.questionFreeze', "**The chat no longer freezes when pi asks you something.** A question or a confirmation arriving while pi was answering could hang the whole window before the question was shown. It now appears and waits for your answer."),
		},
		{
			since: '2.3.1',
			text: localize('picodeWhatsNew.fix.windowAlerts', "**Usage alerts belong to each window.** Every limit (5-hour, weekly, billing period…) has its own bell: set an alert on the weekly window without the 5-hour one going off too. The alerts you had are copied to each window of their model."),
		},
		{
			since: '2.3.1',
			text: localize('picodeWhatsNew.fix.updateSpinner', "**Update all no longer spins its cloud.** While PiCode updates, the button shows a progress spinner instead, and the memory engine is restarted once instead of twice."),
		},
		{
			since: '2.3.1',
			text: localize('picodeWhatsNew.fix.stillIcons', "**What's New icons stay still.** The step you pick in a demo kept its icon spinning; now only progress spinners turn."),
		},
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
