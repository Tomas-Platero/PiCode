/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';

/**
 * A Pro service that brings outside work into the chat (an issue tracker, for now).
 *
 * The Connections page lists whatever is declared here. A connector is announced first
 * (`available: false`) and switched on by whoever builds it: set `available` and give it a
 * `connectCommand`, and its card turns into a working *Connect* button, already behind the Pro check.
 */
export interface IPicodeConnector {
	readonly id: string;
	/** The service whose logo the card shows (see `picodeServiceLogo.ts`). */
	readonly serviceId: string;
	readonly label: string;
	readonly description: string;
	/** False while the connector is announced but not built yet. */
	readonly available: boolean;
	/** Command that starts the connection, for a connector that has no page of its own. */
	readonly connectCommand?: string;
	/**
	 * Set when the connector has its own page in the window (`registerAccountSection`) and its own
	 * connection state: the card then shows that state instead of a button.
	 */
	readonly issues?: 'github' | 'atlassian';
}

const connectors: IPicodeConnector[] = [];

export function registerConnector(connector: IPicodeConnector): void {
	const existing = connectors.findIndex(c => c.id === connector.id);
	if (existing >= 0) {
		connectors[existing] = connector;
	} else {
		connectors.push(connector);
	}
}

export function getConnectors(): readonly IPicodeConnector[] {
	return connectors;
}

registerConnector({
	id: 'githubIssues',
	serviceId: 'github',
	label: localize('picodeConnectorGithub', "GitHub issues"),
	description: localize('picodeConnectorGithubDescription', "Ask the chat about the issues of your repository and work on them."),
	available: true,
	issues: 'github',
});
registerConnector({
	id: 'jiraIssues',
	serviceId: 'atlassian',
	label: localize('picodeConnectorJira', "Jira issues"),
	description: localize('picodeConnectorJiraDescription', "Bring the tickets of your Atlassian projects into the chat."),
	available: true,
	issues: 'atlassian',
});
