/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ⚠️  WARNING — DO NOT ADD SETTINGS HERE ⚠️
//
// This file overrides default configuration values for the Agents window using
// `registerDefaultConfigurations`. Overriding defaults this way is a last resort:
// it bypasses schema metadata, is invisible to tooling, and makes settings harder
// to discover and reason about.
//
// RECOMMENDED APPROACH — use the `agentsWindow` property on the configuration
// schema declaration instead:
//
//   Registry.as<IConfigurationRegistry>(Extensions.Configuration)
//     .registerConfiguration({
//       properties: {
//         'my.setting': {
//           type: 'boolean',
//           default: false,
//           agentsWindow: {
//             default: true,   // ← agents window default (replaces the override here)
//             readOnly: true,  // ← optional: prevent writes from the agents window
//           },
//         },
//       },
//     });
//
// The `agentsWindow.default` value is picked up by `SessionsDefaultConfiguration`
// in `configurationService.ts` and applied automatically — no entry here needed.
//
// Only add entries to this file if the setting is declared by a third party and
// cannot be annotated with `agentsWindow`, AND you have exhausted all other options.
//
// PiCode registers no default overrides here: the Agents-window defaults it needs are
// declared with `agentsWindow` on their own schema.
