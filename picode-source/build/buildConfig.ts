/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * When `true`, self-hosting uses esbuild for fast transpilation (build/next)
 * and gulp-tsb only for type-checking (`noEmit`).
 *
 * When `false`, gulp-tsb does both transpilation and type-checking (old behavior).
 *
 * PiCode: this is upstream's factory value (true). VSCodium had disabled it
 * without leaving a reason anywhere; the disable was dropped on 2026-09-27 when
 * PiCode took ownership of the source. The esbuild packaging route has no
 * type-check of its own, so gulpfile.vscode.ts adds a headless `tsgo --noEmit`
 * step to the prepack series — the shipped artifact stays type-checked either
 * way.
 */
export const useEsbuildTranspile = true;
