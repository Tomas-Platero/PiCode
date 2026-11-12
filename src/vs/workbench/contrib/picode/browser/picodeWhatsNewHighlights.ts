/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';

/** The little working demo beside a highlight's explanation. */
export type WhatsNewPreview = 'layout' | 'issues' | 'plan' | 'job' | 'plans' | 'sync' | 'import' | 'changedFiles' | 'exclude' | 'terminalDialogs' | 'problems' | 'statusSections';

/** What a highlight's button does for real in the editor (see `picodeWhatsNewWindow.ts`). */
export type WhatsNewAction = 'switchLayout' | 'connect' | 'openAccount' | 'showTasks' | 'openImport' | 'fileList' | 'excludeSetting' | 'newTerminal' | 'browseExtensions' | 'chooseSections';

/**
 * One thing worth telling about a version, written for the person using PiCode: what it is, why it
 * helps, and a way to try it. The releases' raw list of changes stays apart, under "All changes".
 *
 * A release that brings something new adds its entry here, newest first, with `since` set to the
 * version that first carries it.
 */
export interface IWhatsNewHighlight {
	readonly id: string;
	/** The version that first has it (`1.0.9`): an update only tells what is new to that person. */
	readonly since: string;
	/** Who gets it: the window always says so, and without Pro the button of a Pro novelty leads to the plans. */
	readonly plan: 'pro' | 'free';
	readonly icon: ThemeIcon;
	readonly title: string;
	readonly summary: string;
	readonly points: readonly string[];
	readonly preview: WhatsNewPreview;
	readonly action?: WhatsNewAction;
}

export function whatsNewHighlights(): readonly IWhatsNewHighlight[] {
	return [
		{
			id: 'statusSections',
			since: '2.2.1',
			plan: 'free',
			icon: Codicon.eyeClosed,
			title: localize('picodeWhatsNew.statusSections.title', "Status, your way"),
			summary: localize('picodeWhatsNew.statusSections.summary', "Fold the sections of Status you glance at, and hide the ones you never use."),
			points: [
				localize('picodeWhatsNew.statusSections.point1', "Click a section title to fold it; click again to open it."),
				localize('picodeWhatsNew.statusSections.point2', "Right-click any title to tick the sections you want to see."),
				localize('picodeWhatsNew.statusSections.point3', "Your choice is remembered, and \"Show all sections\" brings everything back."),
			],
			preview: 'statusSections',
			action: 'chooseSections',
		},
		{
			id: 'changedFiles',
			since: '2.2.0',
			plan: 'free',
			icon: Codicon.diffMultiple,
			title: localize('picodeWhatsNew.changedFiles.title', "Every changed file, in one list"),
			summary: localize('picodeWhatsNew.changedFiles.summary', "When you review all the changes at once, a list of the files sits beside them, so you can jump straight to the one you want."),
			points: [
				localize('picodeWhatsNew.changedFiles.point1', "Each file shows how many lines were added and removed."),
				localize('picodeWhatsNew.changedFiles.point2', "Click a file and its changes come into view."),
				localize('picodeWhatsNew.changedFiles.point3', "It is new, so it starts off: the button below turns it on."),
			],
			preview: 'changedFiles',
			action: 'fileList',
		},
		{
			id: 'exclude',
			since: '2.2.0',
			plan: 'free',
			icon: Codicon.eyeClosed,
			title: localize('picodeWhatsNew.exclude.title', "Hide a folder, keep what you need"),
			summary: localize('picodeWhatsNew.exclude.summary', "Hidden files can now have exceptions: hide a whole folder and still see the one part of it you care about."),
			points: [
				localize('picodeWhatsNew.exclude.point1', "Put \"!\" in front of a path to keep it visible, like \"!node_modules/@types\"."),
				localize('picodeWhatsNew.exclude.point2', "Works for the files list and for search."),
				localize('picodeWhatsNew.exclude.point3', "Exceptions for search only affect search and Go to File."),
			],
			preview: 'exclude',
			action: 'excludeSetting',
		},
		{
			id: 'terminalDialogs',
			since: '2.2.0',
			plan: 'free',
			icon: Codicon.terminal,
			title: localize('picodeWhatsNew.terminalDialogs.title', "Sign-in windows in front"),
			summary: localize('picodeWhatsNew.terminalDialogs.summary', "When a command in the terminal opens a window, like a sign-in prompt, it now appears in front of PiCode instead of hiding behind it."),
			points: [
				localize('picodeWhatsNew.terminalDialogs.point1', "No more hunting for a window that opened somewhere behind the editor."),
				localize('picodeWhatsNew.terminalDialogs.point2', "It follows the window your terminal is in."),
				localize('picodeWhatsNew.terminalDialogs.point3', "Nothing to set up: it works on its own."),
			],
			preview: 'terminalDialogs',
			action: 'newTerminal',
		},
		{
			id: 'problems',
			since: '2.2.0',
			plan: 'free',
			icon: Codicon.warning,
			title: localize('picodeWhatsNew.problems.title', "Every problem in sight"),
			summary: localize('picodeWhatsNew.problems.summary', "Big files now show all their errors and warnings underlined, and more of the newest extensions install."),
			points: [
				localize('picodeWhatsNew.problems.point1', "Up to 5,000 errors and warnings are underlined in a file, ten times more than before."),
				localize('picodeWhatsNew.problems.point2', "More of the newest extensions now install."),
				localize('picodeWhatsNew.problems.point3', "Extensions can now add their own entries to a file's history."),
			],
			preview: 'problems',
			action: 'browseExtensions',
		},
		{
			id: 'import',
			since: '2.0.5',
			plan: 'free',
			icon: Codicon.cloudDownload,
			title: localize('picodeWhatsNew.import.title', "Import from pi or VS Code"),
			summary: localize('picodeWhatsNew.import.summary', "Bring over exactly what you want from your other pi or your VS Code, one item at a time."),
			points: [
				localize('picodeWhatsNew.import.point1', "Packages, themes, extensions, settings and shortcuts: tick only the ones you want."),
				localize('picodeWhatsNew.import.point2', "What you already have in PiCode is never replaced."),
				localize('picodeWhatsNew.import.point3', "Open it any time from the Command Palette: Import from Pi or VS Code."),
			],
			preview: 'import',
			action: 'openImport',
		},
		{
			id: 'issues',
			since: '2.0.0',
			plan: 'pro',
			icon: Codicon.issues,
			title: localize('picodeWhatsNew.issues.title', "GitHub and Jira issues"),
			summary: localize('picodeWhatsNew.issues.summary', "What was reported on your project, right beside your code and ready to hand to the agent."),
			points: [
				localize('picodeWhatsNew.issues.point1', "Only what matters here: each folder shows its own repository or Jira space."),
				localize('picodeWhatsNew.issues.point2', "A real Jira board: drag cards between columns, or open an issue to edit it."),
				localize('picodeWhatsNew.issues.point3', "\"Fix with pi\" prepares the issue in a new chat. You send it when you are ready."),
			],
			preview: 'issues',
			action: 'connect',
		},
		{
			id: 'sync',
			since: '2.0.0',
			plan: 'pro',
			icon: Codicon.cloud,
			title: localize('picodeWhatsNew.sync.title', "Pick what syncs"),
			summary: localize('picodeWhatsNew.sync.summary', "Your setup on every computer, and you choose exactly what travels."),
			points: [
				localize('picodeWhatsNew.sync.point1', "Turn each part on or off: agents, settings, shortcuts and more."),
				localize('picodeWhatsNew.sync.point2', "Bring back your chats from the last 7 days."),
				localize('picodeWhatsNew.sync.point3', "See when it last synced, or sync right now."),
			],
			preview: 'sync',
			action: 'openAccount',
		},
		{
			id: 'account',
			since: '2.0.0',
			plan: 'free',
			icon: Codicon.account,
			title: localize('picodeWhatsNew.account.title', "Your account, in one place"),
			summary: localize('picodeWhatsNew.account.summary', "PiCode is free and complete, with or without an account. Pro adds what needs our servers."),
			points: [
				localize('picodeWhatsNew.account.point1', "Sign up free with email, Google or GitHub."),
				localize('picodeWhatsNew.account.point2', "Your plan, sync and connections, all in one window."),
				localize('picodeWhatsNew.account.point3', "Pro only adds: nothing you use today goes away."),
			],
			preview: 'plans',
			action: 'openAccount',
		},
		{
			id: 'plan',
			since: '2.0.0',
			plan: 'free',
			icon: Codicon.checklist,
			title: localize('picodeWhatsNew.plan.title', "See the agent's plan"),
			summary: localize('picodeWhatsNew.plan.summary', "On longer jobs the agent lists its steps, so you can see how far along it is."),
			points: [
				localize('picodeWhatsNew.plan.point1', "The current step shows what it is doing right now."),
				localize('picodeWhatsNew.plan.point2', "\"Paused\" means it stopped and nothing is running."),
				localize('picodeWhatsNew.plan.point3', "Open any task to see how long it took and what went wrong."),
			],
			preview: 'plan',
			action: 'showTasks',
		},
		{
			id: 'job',
			since: '2.0.0',
			plan: 'free',
			icon: Codicon.terminal,
			title: localize('picodeWhatsNew.job.title', "Background jobs in view"),
			summary: localize('picodeWhatsNew.job.summary', "Long-running commands now show up in Tasks, and the agent tells you when they finish."),
			points: [
				localize('picodeWhatsNew.job.point1', "See what is running, for how long, and its live output."),
				localize('picodeWhatsNew.job.point2', "Finished jobs move out of the way on their own."),
				localize('picodeWhatsNew.job.point3', "The agent's reply lands in your chat, even after its turn ended."),
			],
			preview: 'job',
			action: 'showTasks',
		},
		{
			id: 'layout',
			since: '1.0.0',
			plan: 'free',
			icon: Codicon.layout,
			title: localize('picodeWhatsNew.layout.title', "Agent or Editor"),
			summary: localize('picodeWhatsNew.layout.summary', "Chat in the centre, or code in the centre. Switch any time and lose nothing."),
			points: [
				localize('picodeWhatsNew.layout.point1', "Agent: sessions on the left, chat in the centre, files and status on the right."),
				localize('picodeWhatsNew.layout.point2', "Editor: code in the centre, chat on the side, terminal below."),
				localize('picodeWhatsNew.layout.point3', "The button below switches for real. Press it again to go back."),
			],
			preview: 'layout',
			action: 'switchLayout',
		},
	];
}
