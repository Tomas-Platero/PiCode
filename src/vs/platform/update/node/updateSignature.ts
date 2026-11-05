/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The signature on a full update.
 *
 * The feed says which file to download and which hash it must have, so whoever can change the feed
 * decides what every updater runs. The feed therefore carries an Ed25519 signature over exactly the
 * details the updater acts on, made with the same key as the small update packages. Channel and
 * target are part of what is signed, so a feed cannot be replayed on another channel. Which release
 * counts as newer stays the updater's own comparison, on the signed version.
 *
 * Node's crypto only, so the release pipeline and its tests load this same file.
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** The fields of a feed that the signature covers. */
export interface ISignedUpdateDetails {
	readonly version?: string;
	readonly productVersion?: string;
	readonly picodeVersion?: string;
	readonly sha256hash?: string;
	readonly signature?: string;
}

/** `feedPath` is the feed's place below the update address: `<quality>/<platform>/<arch>[/<target>]`. */
function signedText(update: ISignedUpdateDetails, feedPath: string): string {
	return ['picode-update/v1', feedPath, update.version, update.productVersion, update.picodeVersion ?? '', update.sha256hash?.toLowerCase()].join('\n');
}

/** The feed's signature, base64. Throws when `privateKeyPem` is not a usable key. */
export function signUpdate(update: ISignedUpdateDetails, feedPath: string, privateKeyPem: string): string {
	return sign(null, Buffer.from(signedText(update, feedPath)), createPrivateKey(privateKeyPem)).toString('base64');
}

/** Whether the feed was signed by the holder of `publicKey`, for this place. Never throws. */
export function verifyUpdateSignature(update: ISignedUpdateDetails, feedPath: string, publicKey: string): boolean {
	if (typeof update.signature !== 'string' || typeof update.sha256hash !== 'string' || typeof update.version !== 'string' || typeof update.productVersion !== 'string') {
		return false;
	}
	try {
		const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
		return verify(null, Buffer.from(signedText(update, feedPath)), key, Buffer.from(update.signature, 'base64'));
	} catch {
		return false;
	}
}

/**
 * The feed's place below the update address, read off the address it was fetched from, or
 * `undefined` when that address is not one of this product's feeds.
 */
export function feedPathOf(feedUrl: string, updateUrl: string): string | undefined {
	const suffix = '/latest.json';
	const prefix = `${updateUrl}/`;
	return feedUrl.startsWith(prefix) && feedUrl.endsWith(suffix) ? feedUrl.slice(prefix.length, -suffix.length) : undefined;
}
