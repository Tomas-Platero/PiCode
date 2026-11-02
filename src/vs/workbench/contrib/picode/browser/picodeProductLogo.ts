/*---------------------------------------------------------------------------------------------
 *  Copyright (c) PiCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';

/**
 * PiCode's mark, drawn as strokes, in the colors of the theme.
 *
 * Inlined in the DOM rather than loaded as an image for the same reason the editor's empty
 * watermark is a stroke drawing: a plated logo at this size reads as a dark block, and an
 * image with a fixed stroke color cannot follow the theme. The body strokes are
 * `currentColor` (the theme's foreground), and the accents keep PiCode's own blue on every
 * theme. No background: only the silhouette is drawn.
 *
 * Shared by the Welcome page's header and the chat's empty greeting, so the two show one mark.
 */
export function buildPicodeProductLogo(): HTMLElement {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const ACCENT = '#3B9BFF';

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 1024 1024');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('product-logo-svg');

	const group = document.createElementNS(SVG_NS, 'g');
	group.setAttribute('transform', 'translate(0,92)');
	group.setAttribute('fill', 'none');
	group.setAttribute('stroke', 'currentColor');
	group.setAttribute('stroke-width', '84');
	group.setAttribute('stroke-linecap', 'round');
	group.setAttribute('stroke-linejoin', 'round');

	const path = (d: string, width: number, color: string) => {
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('d', d);
		p.setAttribute('stroke-width', String(width));
		if (color !== 'currentColor') { p.setAttribute('stroke', color); }
		group.appendChild(p);
	};
	const dot = (cx: number, cy: number, r: number, color: string) => {
		const c = document.createElementNS(SVG_NS, 'circle');
		c.setAttribute('cx', String(cx));
		c.setAttribute('cy', String(cy));
		c.setAttribute('r', String(r));
		c.setAttribute('fill', color);
		// The group carries the stroke, and the dots of the mark are fills: without an explicit
		// `none` they would inherit the group's 84-unit stroke and render as blobs (the eyes
		// became the whole face). The source SVG says the same on every circle.
		c.setAttribute('stroke', 'none');
		group.appendChild(c);
	};

	path('M512 200 V152', 60, 'currentColor');
	dot(512, 112, 48, ACCENT);
	path('M360 640 V262 Q360 200 422 200 H602 Q664 200 664 262 V640', 84, 'currentColor');
	path('M268 432 H756', 84, 'currentColor');
	dot(452, 316, 34, ACCENT);
	dot(572, 316, 34, ACCENT);
	path('M424 590 L360 660 L424 730', 84, ACCENT);
	path('M600 590 L664 660 L600 730', 84, ACCENT);

	svg.appendChild(group);
	const container = $('div.product-logo');
	container.appendChild(svg);
	return container;
}
