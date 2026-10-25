/*
 * The setup window's backend, as a process.
 *
 * The window that runs before the editor has no extension host, so the connector's own modules
 * are loaded here directly: this file is a shim, not logic. Everything it does lives in
 * `extensions/picode/src/onboarding-host.ts` — the same module that would run inside the
 * extension — and the workbench compile has already produced it at `<connector>/out/onboarding-host.js`.
 *
 * Usage:  <electron> host.cjs <command>        payload JSON on stdin, answer JSON on stdout
 *         PICODE_ONBOARDING_CONNECTOR          the connector's compiled folder (required)
 *         PICODE_ONBOARDING_DISTRIBUTION_ROOT  the distribution root
 *         PICODE_ONBOARDING_PROFILE_DIR        PiCode's own pi profile
 *         PICODE_ONBOARDING_USER_DATA          the editor's user data directory
 *
 * One command per process, deliberately: a crash while importing a profile cannot take the
 * window down with it, and the main process always sees a clean exit or a sentence saying what
 * went wrong.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONNECTOR = process.env['PICODE_ONBOARDING_CONNECTOR'];

async function readStdin() {
	return new Promise((resolve, reject) => {
		let text = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => { text += chunk; });
		process.stdin.on('end', () => resolve(text));
		process.stdin.on('error', reject);
	});
}

/**
 * The channel the answers travel on.
 *
 * Not a bare stdout line, because loading pi runs npm the first time (its declared packages get
 * installed) and a package manager prints whatever it likes. Every protocol line therefore wears
 * a marker, and the main process reads only the marked ones — a pipe shared with npm is fine as
 * long as the protocol can tell itself apart from the noise.
 *
 * (File descriptor 3 was the first attempt and does not survive this spawn on Windows: the writes
 * fall back to stdout, which is how the prompt ended up in the log instead of the window.)
 */
const MARK = '##picode##';

function protocolLine(text) {
	process.stdout.write(MARK + text + String.fromCharCode(10));
}

function write(answer) {
	protocolLine(JSON.stringify(answer));
}

async function main() {
	if (!CONNECTOR) {
		write({ ok: false, error: 'the setup host was started without the connector path' });
		return;
	}

	let host;
	try {
		host = require(path.join(CONNECTOR, 'onboarding-host.js'));
	} catch (error) {
		write({ ok: false, error: `the setup host could not load the connector: ${error instanceof Error ? error.message : String(error)}` });
		return;
	}

	const paths = host.setupPathsFromEnv(process.env);
	if (!paths) {
		write({ ok: false, error: 'the setup host was started without the paths it writes to' });
		return;
	}

	const command = process.argv[2];
	if (typeof command !== 'string' || command.length === 0) {
		write({ ok: false, error: 'the setup host was started without a command' });
		return;
	}

	// A sign-in is not a command with an answer: it is a conversation that lasts as long as the
	// owner takes in a browser. It gets its own line-based protocol, in both directions.
	if (command === 'login') {
		await loginStreaming(host, paths, process.argv[3]);
		return;
	}

	let payload = {};
	const text = await readStdin();
	if (text.trim().length > 0) {
		try {
			payload = JSON.parse(text);
		} catch {
			// A command that carries nothing is fine; a payload that cannot be read is not.
			write({ ok: false, error: 'the setup host was handed a payload it could not read' });
			return;
		}
	}

	try {
		write({ ok: true, data: await host.runHostCommand(paths, command, payload) });
	} catch (error) {
		write({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * One subscription sign-in, as a conversation.
 *
 * stdout carries one JSON object per line — `event` (what pi says), `prompt` (what pi asks),
 * `done`/`cancelled`/`error` (how it ended). stdin carries the answers, by prompt id, and a
 * `cancel` that ends it. Nothing is invented here: pi's own `notify` and `prompt` are the source.
 */
async function loginStreaming(host, paths, providerId) {
	// Every line wears the marker: this pipe is shared with pi's own output.
	const send = object => {
		protocolLine(JSON.stringify(object));
	};
	const pending = new Map();
	let nextId = 0;
	let cancelled = false;

	// Answers arrive as lines; a line that cannot be read is ignored rather than fatal.
	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', chunk => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length === 0) {
				continue;
			}
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message.type === 'cancel') {
				cancelled = true;
				for (const entry of pending.values()) {
					entry.reject(Object.assign(new Error('the sign-in was cancelled'), { cancelled: true }));
				}
				pending.clear();
			} else if (message.type === 'answer') {
				const entry = pending.get(String(message.id));
				if (entry) {
					pending.delete(String(message.id));
					entry.resolve(typeof message.value === 'string' ? message.value : '');
				}
			}
		}
	});
	// The window closing takes the pipe with it: nothing is left waiting on a person who is gone.
	process.stdin.on('end', () => {
		cancelled = true;
		for (const entry of pending.values()) {
			entry.reject(Object.assign(new Error('the setup window closed'), { cancelled: true }));
		}
		pending.clear();
	});

	const bridge = {
		notify(event) {
			send({ type: 'event', event });
		},
		prompt(prompt) {
			const id = String(++nextId);
			send({ type: 'prompt', id, prompt });
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		},
	};

	try {
		await host.loginProvider(paths, providerId, bridge);
		send({ type: 'done' });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (cancelled || (error !== null && typeof error === 'object' && error.cancelled === true)) {
			send({ type: 'cancelled' });
		} else {
			send({ type: 'error', message });
		}
	}
	process.exit(0);
}

main().catch(error => {
	write({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
