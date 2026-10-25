/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Gentle's two preferences the editor lets the owner change: how it talks (its persona) and how much
 * it asks before acting (its default permissions).
 *
 * Gentle keeps each in a small file of its own in `<profile>/gentle-ai/` and reads it when a chat
 * session starts. Its terminal changes them with `/gentle:persona` and `/gentle:mode default …`;
 * the editor writes the same files, in the same shape, so either side reads what the other wrote.
 *
 * No `vscode` import, so `node --test` runs this file directly.
 */

export type Persona = 'gentleman' | 'neutral';
export type Permissions = 'normal' | 'auto' | 'yolo';

export const PERSONAS: readonly Persona[] = ['gentleman', 'neutral'];
export const PERMISSIONS: readonly Permissions[] = ['normal', 'auto', 'yolo'];

/** The first line of the permissions file, which gentle refuses to read without. */
const PERMISSIONS_SCHEMA = 'gentle-pi.permission-mode/v1';

export interface GentleSettings {
	readonly persona: Persona;
	/** What new sessions start with. */
	readonly permissions: Permissions;
	/** The permissions file exists but gentle could not read it: it must be repaired before it is replaced. */
	readonly permissionsBroken: boolean;
}

function personaFile(profileDir: string): string {
	return path.join(profileDir, 'gentle-ai', 'persona.json');
}

function permissionsFile(profileDir: string): string {
	return path.join(profileDir, 'gentle-ai', 'permission-mode.json');
}

export function isPersona(value: unknown): value is Persona {
	return value === 'gentleman' || value === 'neutral';
}

export function isPermissions(value: unknown): value is Permissions {
	return value === 'normal' || value === 'auto' || value === 'yolo';
}

function readJson(file: string): { readonly found: boolean; readonly value: unknown } {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return { found: false, value: undefined };
	}
	try {
		return { found: true, value: JSON.parse(text) };
	} catch {
		return { found: true, value: undefined };
	}
}

/** The persona: anything that is not `neutral` is the default one, exactly as gentle reads it. */
function readPersona(profileDir: string): Persona {
	const { value } = readJson(personaFile(profileDir));
	return typeof value === 'object' && value !== null && (value as { mode?: unknown }).mode === 'neutral' ? 'neutral' : 'gentleman';
}

/** The permissions file as gentle accepts it: exactly the schema and a mode, nothing else. */
function readPermissions(profileDir: string): { readonly mode: Permissions; readonly broken: boolean } {
	const { found, value } = readJson(permissionsFile(profileDir));
	if (!found) {
		return { mode: 'normal', broken: false };
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 2) {
		const record = value as { schema?: unknown; mode?: unknown };
		if (record.schema === PERMISSIONS_SCHEMA && isPermissions(record.mode)) {
			return { mode: record.mode, broken: false };
		}
	}
	return { mode: 'normal', broken: true };
}

export function gentleSettings(profileDir: string): GentleSettings {
	const permissions = readPermissions(profileDir);
	return { persona: readPersona(profileDir), permissions: permissions.mode, permissionsBroken: permissions.broken };
}

function writeAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, text, 'utf8');
	fs.renameSync(temporary, file);
}

/**
 * One change from the settings page: `key` is `persona` or `permissions`. Anything else is
 * refused, and so is replacing a permissions file gentle could not read — that one needs a person.
 */
export function setGentleSetting(profileDir: string, request: unknown): GentleSettings {
	const { key, value } = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
	if (key === 'persona' && isPersona(value)) {
		writeAtomic(personaFile(profileDir), `${JSON.stringify({ mode: value }, undefined, 2)}\n`);
	} else if (key === 'permissions' && isPermissions(value)) {
		if (readPermissions(profileDir).broken) {
			throw new Error('The saved permissions could not be read. Delete the file and try again.');
		}
		writeAtomic(permissionsFile(profileDir), `${JSON.stringify({ schema: PERMISSIONS_SCHEMA, mode: value })}\n`);
	} else {
		throw new Error('That is not a setting Gentle has.');
	}
	return gentleSettings(profileDir);
}
