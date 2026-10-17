/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isBoolean } from '../../../base/common/types.js';

export type Agent = any;

function getSystemProxyURI(requestURL: URL, env: typeof process.env): string | null {
	if (requestURL.protocol === 'http:') {
		return env.HTTP_PROXY || env.http_proxy || null;
	} else if (requestURL.protocol === 'https:') {
		return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
	}

	return null;
}

export interface IOptions {
	proxyUrl?: string;
	strictSSL?: boolean;
}

export async function getProxyAgent(rawRequestURL: string, env: typeof process.env, options: IOptions = {}): Promise<Agent> {
	// The WHATWG URL constructor, not the legacy `url.parse`: Node deprecates the latter
	// (DEP0169), and the warning surfaced in the extension host on the first proxied request.
	// A URL this layer cannot parse is a URL no proxy agent can serve: fall back to a direct
	// connection instead of throwing into the request path.
	let requestURL: URL;
	try {
		requestURL = new URL(rawRequestURL);
	} catch {
		return null;
	}
	const proxyURL = options.proxyUrl || getSystemProxyURI(requestURL, env);

	if (!proxyURL) {
		return null;
	}

	let proxyEndpoint: URL;
	try {
		proxyEndpoint = new URL(proxyURL);
	} catch {
		return null;
	}

	if (!/^https?:$/.test(proxyEndpoint.protocol || '')) {
		return null;
	}

	const opts = {
		host: proxyEndpoint.hostname || '',
		// The protocol comparison carries the colon in the WHATWG URL ("https:"), so an https
		// proxy endpoint without an explicit port now defaults to 443, as it always should
		// have: the legacy `url.parse` comparison never matched and sent https proxies to 80.
		port: (proxyEndpoint.port ? +proxyEndpoint.port : 0) || (proxyEndpoint.protocol === 'https:' ? 443 : 80),
		auth: proxyEndpoint.username ? `${proxyEndpoint.username}:${proxyEndpoint.password}` : undefined,
		rejectUnauthorized: isBoolean(options.strictSSL) ? options.strictSSL : true,
	};

	if (requestURL.protocol === 'http:') {
		const { default: mod } = await import('http-proxy-agent');
		return new mod.HttpProxyAgent(proxyURL, opts);
	} else {
		const { default: mod } = await import('https-proxy-agent');
		return new mod.HttpsProxyAgent(proxyURL, opts);
	}
}
