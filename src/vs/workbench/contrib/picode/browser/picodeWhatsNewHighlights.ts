/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';

/** The little working demo beside a highlight's explanation. */
export type WhatsNewPreview = 'layout' | 'issues' | 'plan' | 'job' | 'plans' | 'sync' | 'import' | 'changedFiles' | 'exclude' | 'terminalDialogs' | 'problems' | 'statusSections' | 'context' | 'providers' | 'projects' | 'usage' | 'browser' | 'usageAlerts' | 'sessionBranches' | 'parallelSessions' | 'setup' | 'agentProfiles' | 'syncParts' | 'settings' | 'themes' | 'chatPreferences';

/** What a highlight's button does for real in the editor (see `picodeWhatsNewWindow.ts`). */
export type WhatsNewAction = 'switchLayout' | 'connect' | 'openAccount' | 'showTasks' | 'openImport' | 'fileList' | 'excludeSetting' | 'newTerminal' | 'browseExtensions' | 'chooseSections' | 'showStatus' | 'openProviders' | 'addProject' | 'showUsageLimits' | 'openBrowser' | 'newIsolatedSession' | 'openSetup' | 'openAgentProfiles' | 'openCloudSync' | 'openSettings' | 'openThemes';

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
			id: 'syncRecovery',
			since: '2.4.11',
			plan: 'pro',
			icon: Codicon.cloud,
			title: localize('picodeWhatsNew.syncRecovery.title', "Pick up where you left off"),
			summary: localize('picodeWhatsNew.syncRecovery.summary', "Cloud sync checks for changes when you return to PiCode or reconnect. Changes waiting to upload stay pending when you close the editor."),
			points: [
				localize('picodeWhatsNew.syncRecovery.point1', "Retry a category in Cloud sync, or compare and restore an earlier version from Earlier copies."),
			],
			preview: 'syncParts',
			action: 'openCloudSync',
		},
		{
			id: 'accountOverview',
			since: '2.4.11',
			plan: 'free',
			icon: Codicon.account,
			title: localize('picodeWhatsNew.accountOverview.title', "A clearer place to sign in"),
			summary: localize('picodeWhatsNew.accountOverview.summary', "Open Account in Settings to find the new sign-in card and refreshed GitHub and Jira connections."),
			points: [
				localize('picodeWhatsNew.accountOverview.point1', "The active Agent or Editor mode is easier to see in the title bar."),
			],
			preview: 'settings',
			action: 'openAccount',
		},
		{
			id: 'chatPreferences',
			since: '2.4.10',
			plan: 'free',
			icon: Codicon.settingsGear,
			title: localize('picodeWhatsNew.chatPreferences.title', "Make PiCode work your way"),
			summary: localize('picodeWhatsNew.chatPreferences.summary', "Make chat, memory and your workspace feel more like yours with new choices in Settings."),
			points: [
				localize('picodeWhatsNew.chatPreferences.point1', "Choose how to send messages and whether to confirm before sending or saving memories."),
				localize('picodeWhatsNew.chatPreferences.point2', "Choose your first Agent tab and find more options for the editor, files and terminal."),
			],
			preview: 'chatPreferences',
			action: 'openSettings',
		},
		{
			id: 'themeGallery',
			since: '2.4.3',
			plan: 'free',
			icon: Codicon.symbolColor,
			title: localize('picodeWhatsNew.themes.title.warm', "Find a look you love"),
			summary: localize('picodeWhatsNew.themes.summary.warm', "Themes now have a gallery of their own. Each one shows up as a little window in its real colours, so you can see how it feels before you pick it."),
			points: [
				localize('picodeWhatsNew.themes.point1.warm', "Hover over a theme to try it on the whole editor. Like it? Just click."),
				localize('picodeWhatsNew.themes.point2.warm', "Looking for something dark, light or high-contrast? Filter or search in a second."),
				localize('picodeWhatsNew.themes.point3.warm', "Spotted one in the gallery? One click and it's yours."),
			],
			preview: 'themes',
			action: 'openThemes',
		},
		{
			id: 'settingsWindow',
			since: '2.4.2',
			plan: 'free',
			icon: Codicon.settingsGear,
			title: localize('picodeWhatsNew.settings.title.warm', "All your settings, in one friendly place"),
			summary: localize('picodeWhatsNew.settings.summary.warm', "Your preferences, your account and your AI now live together in one window, neatly grouped and easy to search. Change something and you'll see it right away."),
			points: [
				localize('picodeWhatsNew.settings.point1.warm', "Press Ctrl+, or the gear to open it. Your avatar, Sync and the usage ring take you straight to the right page."),
				localize('picodeWhatsNew.settings.point2.warm', "Everything has one home, so you always know where to look."),
				localize('picodeWhatsNew.settings.point3.warm', "Need something more advanced? Every setting is still one click away."),
			],
			preview: 'settings',
			action: 'openSettings',
		},
		{
			id: 'agentProfiles',
			since: '2.4.0',
			plan: 'free',
			icon: Codicon.layers,
			title: localize('picodeWhatsNew.agentProfiles.title.warm', "The right model for every job"),
			summary: localize('picodeWhatsNew.agentProfiles.summary.warm', "Save which model each agent uses as a profile, with a backup in case one is busy. Keep a few for different days, like everyday, budget or deep work, and switch in one click."),
			points: [
				localize('picodeWhatsNew.agentProfiles.point1.warm', "The chat shows the profile you're using; click it to switch for all new chats, or just this one."),
				localize('picodeWhatsNew.agentProfiles.point2.warm', "Give a project its own profile and its chats will start with it."),
				localize('picodeWhatsNew.agentProfiles.point3.warm', "Each editor profile can bring its own agent profile along."),
			],
			preview: 'agentProfiles',
			action: 'openAgentProfiles',
		},
		{
			id: 'layoutSwitch',
			since: '2.4.0',
			plan: 'free',
			icon: Codicon.robot,
			title: localize('picodeWhatsNew.layoutSwitch.title.warm', "Agent or Editor, just a click away"),
			summary: localize('picodeWhatsNew.layoutSwitch.summary.warm', "A little switch at the top right shows the layout you're in and takes you to the other one whenever you like."),
			points: [
				localize('picodeWhatsNew.layoutSwitch.point1.warm', "One look tells you where you are."),
				localize('picodeWhatsNew.layoutSwitch.point2.warm', "It changes instantly, no restart needed. Watch the robot blink!"),
			],
			preview: 'layout',
			action: 'switchLayout',
		},
		{
			id: 'syncParts',
			since: '2.4.0',
			plan: 'pro',
			icon: Codicon.cloud,
			title: localize('picodeWhatsNew.syncParts.title.warm', "Your setup, everywhere you go"),
			summary: localize('picodeWhatsNew.syncParts.summary.warm', "Choose exactly what follows you to your other computers, piece by piece, from one clear page in your account."),
			points: [
				localize('picodeWhatsNew.syncParts.point1.warm', "Pick what travels: your agents, skills, profiles, MCP servers, models and more."),
				localize('picodeWhatsNew.syncParts.point2.warm', "Your keys and passwords never leave this computer."),
				localize('picodeWhatsNew.syncParts.point3.warm', "You'll find it in your account, under Cloud sync."),
			],
			preview: 'syncParts',
			action: 'openCloudSync',
		},
		{
			id: 'setup',
			since: '2.3.0',
			plan: 'free',
			icon: Codicon.rocket,
			title: localize('picodeWhatsNew.setup.title', "A shorter, clearer setup"),
			summary: localize('picodeWhatsNew.setup.summary', "The first-run setup now takes five steps instead of seven, and every choice you make shows up at once, without the window jumping."),
			points: [
				localize('picodeWhatsNew.setup.point1', "Welcome, Layout, Agent, Look and Ready: the agent and its model are chosen together, on one step."),
				localize('picodeWhatsNew.setup.point2', "Themes preview beside the grid as you point at them; the rarer options wait under Advanced."),
				localize('picodeWhatsNew.setup.point3', "Escape no longer skips the whole setup, and Skip always means the same thing."),
			],
			preview: 'setup',
			action: 'openSetup',
		},
		{
			id: 'parallelSessions',
			since: '2.3.0',
			plan: 'free',
			icon: Codicon.gitBranch,
			title: localize('picodeWhatsNew.parallelSessions.title', "Several sessions at once, each on its own branch"),
			summary: localize('picodeWhatsNew.parallelSessions.summaryWorktree', "Tick \"Worktree\" under a new chat and the session works in its own copy of the project, on its own branch, so several can work at the same time without touching each other's files."),
			points: [
				localize('picodeWhatsNew.parallelSessions.pointName', "The branch is named after your first message, and you can rename the session from its row."),
				localize('picodeWhatsNew.parallelSessions.point2', "Two chats answer at the same time, each with its own questions and its own changed files."),
				localize('picodeWhatsNew.parallelSessions.pointFinishWorktree', "From the session's row: review its changes, create a pull request or merge it. Archiving it offers to remove the worktree."),
			],
			preview: 'parallelSessions',
			action: 'newIsolatedSession',
		},
		{
			id: 'sessionBranches',
			since: '2.3.0',
			plan: 'free',
			icon: Codicon.gitPullRequest,
			title: localize('picodeWhatsNew.sessionBranches.title', "Each session shows its branch"),
			summary: localize('picodeWhatsNew.sessionBranches.summary', "In the Agent layout, a session that worked on a branch other than the main one shows it on its row. Point at it to see the branches it went through."),
			points: [
				localize('picodeWhatsNew.sessionBranches.point1', "The branch is saved after every answer, so older sessions keep the branch they really used."),
				localize('picodeWhatsNew.sessionBranches.point2', "With GitHub connected (Pro), the card also lists the branch's pull requests: open, merged or closed."),
				localize('picodeWhatsNew.sessionBranches.point3', "Click a pull request to open it on GitHub."),
			],
			preview: 'sessionBranches',
		},
		{
			id: 'usageAlerts',
			since: '2.2.9',
			plan: 'free',
			icon: Codicon.bell,
			title: localize('picodeWhatsNew.usageAlerts.title', "Alerts for your plan's limits"),
			summary: localize('picodeWhatsNew.usageAlerts.summary', "Set alerts on each model in Usage limits, like alarms on a phone: PiCode tells you when a window passes the percentage you chose."),
			points: [
				localize('picodeWhatsNew.usageAlerts.point1', "Add as many as you want to each model, each with its own percentage."),
				localize('picodeWhatsNew.usageAlerts.point2', "A mark on the bars shows where each alert will go off; switch one off without removing it."),
				localize('picodeWhatsNew.usageAlerts.point3', "Each alert goes off once per window, and also as a system notification when PiCode is in the background."),
			],
			preview: 'usageAlerts',
			action: 'showUsageLimits',
		},
		{
			id: 'browser',
			since: '2.2.8',
			plan: 'free',
			icon: Codicon.globe,
			title: localize('picodeWhatsNew.browser.title', "pi checks your pages on its own"),
			summary: localize('picodeWhatsNew.browser.summary', "pi can now use the editor's built-in browser: after changing a web page, it opens it, looks at it and fixes what is off before telling you it is done."),
			points: [
				localize('picodeWhatsNew.browser.point1', "It starts your project if it is not running, opens the page and tries what it changed."),
				localize('picodeWhatsNew.browser.point2', "It reads the page and takes screenshots, so it sees what you would see."),
				localize('picodeWhatsNew.browser.point3', "Ask it to look at or debug any page, including a localhost address."),
			],
			preview: 'browser',
			action: 'openBrowser',
		},
		{
			id: 'usage',
			since: '2.2.7',
			plan: 'free',
			icon: Codicon.dashboard,
			title: localize('picodeWhatsNew.usage.title', "Your plan's limits, beside the chat"),
			summary: localize('picodeWhatsNew.usage.summary', "A small ring next to the thinking level fills up as you use your ChatGPT, Claude or NaN plan, so you see a limit coming before you hit it."),
			points: [
				localize('picodeWhatsNew.usage.point1', "It turns orange at 80% and red at 95% of the tightest window."),
				localize('picodeWhatsNew.usage.point2', "Point at it to see each limit with its bar and when it resets."),
				localize('picodeWhatsNew.usage.point3', "Click it to open Usage limits with every plan you have."),
			],
			preview: 'usage',
			action: 'showUsageLimits',
		},
		{
			id: 'projects',
			since: '2.2.6',
			plan: 'free',
			icon: Codicon.rootFolder,
			title: localize('picodeWhatsNew.projects.title', "Your projects beside your sessions"),
			summary: localize('picodeWhatsNew.projects.summary', "In the Agent layout, the sessions column now lists the folders of your workspace, so you always see what the chat is working on."),
			points: [
				localize('picodeWhatsNew.projects.point1', "Add a project with the + button, or drop folders on the list."),
				localize('picodeWhatsNew.projects.point2', "Hover a project to open a terminal in it or take it out of the workspace."),
				localize('picodeWhatsNew.projects.point3', "Right-click for more: show it in the Explorer or copy its path."),
			],
			preview: 'projects',
			action: 'addProject',
		},
		{
			id: 'providers',
			since: '2.2.5',
			plan: 'free',
			icon: Codicon.plug,
			title: localize('picodeWhatsNew.providers.title', "Connect any provider in one click"),
			summary: localize('picodeWhatsNew.providers.summary', "Providers is now a gallery: sign in with ChatGPT, Claude or Copilot, or paste a key, without leaving the page."),
			points: [
				localize('picodeWhatsNew.providers.point1', "Your browser opens by itself and the sign-in finishes on its own: nothing to copy or paste."),
				localize('picodeWhatsNew.providers.point2', "More than forty providers, with their logos and a search box."),
				localize('picodeWhatsNew.providers.point3', "If the connection drops halfway, PiCode tries again on its own."),
			],
			preview: 'providers',
			action: 'openProviders',
		},
		{
			id: 'context',
			since: '2.2.2',
			plan: 'free',
			icon: Codicon.dashboard,
			title: localize('picodeWhatsNew.context.title', "See where your context goes"),
			summary: localize('picodeWhatsNew.context.summary', "Context in Status now shows what fills the conversation, part by part, and lets you compact it with one click."),
			points: [
				localize('picodeWhatsNew.context.point1', "One colour per part: messages, project instructions, skills, tools and more."),
				localize('picodeWhatsNew.context.point2', "How much room is left before the conversation is compacted on its own."),
				localize('picodeWhatsNew.context.point3', "\"Compact session\" summarises it now, when you choose."),
			],
			preview: 'context',
			action: 'showStatus',
		},
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
