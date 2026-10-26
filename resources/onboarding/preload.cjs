/*
 * The setup window's only bridge to the main process.
 *
 * The page is a plain local HTML file with no node and no workbench, so this file is all it
 * gets: five named operations, each mapped to a fixed channel. There is no generic `invoke`
 * here on purpose — a page cannot name a channel the main process did not offer, and the main
 * process checks that every call comes from this window's own web contents.
 *
 * Nothing in here decides anything: it forwards, and it fails loudly when the other side is
 * gone, because a setup that cannot save should say so rather than pretend.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
	bootstrap: 'picode-onboarding:bootstrap',
	command: 'picode-onboarding:command',
	finish: 'picode-onboarding:finish',
	chooseFolder: 'picode-onboarding:choose-folder',
	clone: 'picode-onboarding:clone',
	openExternal: 'picode-onboarding:open-external',
	copyText: 'picode-onboarding:copy-text',
	accountSignIn: 'picode-onboarding:account-sign-in',
	accountCancel: 'picode-onboarding:account-cancel',
	accountEvent: 'picode-onboarding:account-event',
	accountState: 'picode-onboarding:account-state',
	loginStart: 'picode-onboarding:login-start',
	loginAnswer: 'picode-onboarding:login-answer',
	loginCancel: 'picode-onboarding:login-cancel',
	loginEvent: 'picode-onboarding:login-event',
};

contextBridge.exposeInMainWorld('picode', {
	/** What this window is, what is configured, and where the flag lives. */
	bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),

	/** One backend command: the page names it, the backend decides what it means. */
	command: (name, payload) => ipcRenderer.invoke(CHANNELS.command, name, payload ?? {}),

	/** Records the setup as done and closes the window; the editor opens next. */
	finish: result => ipcRenderer.invoke(CHANNELS.finish, result ?? {}),

	/** The system's folder picker, for the last step. */
	chooseFolder: () => ipcRenderer.invoke(CHANNELS.chooseFolder),

	/** Clones a repository into a folder the owner picks. */
	clone: url => ipcRenderer.invoke(CHANNELS.clone, url),

	/** Signs in to PiCode right here: the browser opens and the window waits for the answer. */
	account: {
		signIn: () => ipcRenderer.invoke(CHANNELS.accountSignIn),
		cancel: () => ipcRenderer.invoke(CHANNELS.accountCancel),
		/** The editor's own auth state, watched from the shared settings file. */
		onState: listener => {
			const handler = (_event, message) => listener(message);
			ipcRenderer.on(CHANNELS.accountState, handler);
			return () => ipcRenderer.removeListener(CHANNELS.accountState, handler);
		},
		onEvent: listener => {
			const handler = (_event, message) => listener(message);
			ipcRenderer.on(CHANNELS.accountEvent, handler);
			return () => ipcRenderer.removeListener(CHANNELS.accountEvent, handler);
		},
	},

	/** Opens a provider's key page in the browser, from a list the main process allows. */
	openExternal: url => ipcRenderer.invoke(CHANNELS.openExternal, url),

	/** Copies a short piece of text to the clipboard. */
	copyText: text => ipcRenderer.invoke(CHANNELS.copyText, text),

	/**
	 * A subscription sign-in: started, answered, cancelled, and listened to.
	 *
	 * The events are pi's own (`event`, `prompt`, `done`, `cancelled`, `error`); this file only
	 * carries them, so the page and the backend speak the same words.
	 */
	signIn: {
		start: providerId => ipcRenderer.invoke(CHANNELS.loginStart, providerId),
		answer: (id, value) => ipcRenderer.invoke(CHANNELS.loginAnswer, id, value),
		cancel: () => ipcRenderer.invoke(CHANNELS.loginCancel),
		onEvent: listener => {
			const handler = (_event, message) => listener(message);
			ipcRenderer.on(CHANNELS.loginEvent, handler);
			return () => ipcRenderer.removeListener(CHANNELS.loginEvent, handler);
		},
	},
});
