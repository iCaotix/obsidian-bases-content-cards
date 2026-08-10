import type { BasesPropertyId, BasesViewConfig } from 'obsidian';

import { parseSelector, type Selector } from './selector';

/**
 * Grid row height in px. Must match --bcc-row-height in styles.css, where row-gap
 * is deliberately 0 — any row gap would be inserted between every row of a span
 * and multiply the card's reserved height.
 */
export const ROW_HEIGHT = 8;

/** Card heights in grid rows. */
export const SIZE_STEPS = { s: 20, m: 30, l: 42, xl: 56 } as const;
export type SizeName = keyof typeof SIZE_STEPS;

/** How hard the per-note hue is mixed into a card. The rest lives in the stylesheet. */
export type TintName = 'off' | 'subtle' | 'strong';

/** Maximum-height setting that lets a card grow to whatever its cover needs. */
export const UNLIMITED = 'unlimited';

/** The view options, read once per data update and passed around as one value. */
export interface RenderParams {
	selector: Selector;
	selectorProperty: BasesPropertyId | null;
	maxLength: number;
	markdown: boolean;
	wrapTitle: boolean;
	newTab: boolean;
	tint: TintName;
	uniform: boolean;
	maxSpan: number;
}

export function readParams(config: BasesViewConfig): RenderParams {
	const maxSize = asString(config.get('maxSize'), 'l');

	return {
		selector: parseSelector(asString(config.get('coverSelector'), ':')) ?? { kind: 'body' },
		selectorProperty: config.getAsPropertyId('selectorProperty'),
		maxLength: asNumber(config.get('maxLength'), 300),
		markdown: config.get('renderMarkdown') === true,
		wrapTitle: config.get('wrapTitle') === true,
		newTab: config.get('openInNewTab') === true,
		tint: asTintName(asString(config.get('cardTint'), 'off')),
		uniform: config.get('cardSize') === 'uniform',
		maxSpan: maxSize === UNLIMITED ? Number.POSITIVE_INFINITY : SIZE_STEPS[asSizeName(maxSize)],
	};
}

/** What a view shows before Bases has handed it any configuration. */
export function defaultParams(): RenderParams {
	return {
		selector: { kind: 'body' },
		selectorProperty: null,
		maxLength: 300,
		markdown: false,
		wrapTitle: false,
		newTab: false,
		tint: 'off',
		uniform: false,
		maxSpan: SIZE_STEPS.l,
	};
}

/**
 * The initial height guess. `file.stat.size` is available without touching the
 * disk, which is the whole point: a card claims correctly graded space before its
 * text has been read, so nothing jumps once it arrives.
 */
export function stepFromFileSize(bytes: number): SizeName {
	if (bytes < 600) return 's';
	if (bytes < 1800) return 'm';
	if (bytes < 4500) return 'l';
	return 'xl';
}

/** No card is smaller than the smallest step, or taller than the setting allows. */
export function clampSpan(span: number, maxSpan: number): number {
	return Math.min(maxSpan, Math.max(SIZE_STEPS.s, span));
}

/**
 * The span a card should have, from what it currently grants its cover
 * (`available`) and what the text wants (`needed`) — an absolute pair, not a delta
 * from the last pass, so repeating this at a new width converges in one go and can
 * shrink a card as readily as it grows one. Rows are granted by rounding up: half
 * a row of slack looks like nothing, half a row of missing text looks like a bug.
 */
export function nextSpan(span: number, needed: number, available: number, maxSpan: number): number {
	return clampSpan(span + Math.ceil((needed - available) / ROW_HEIGHT), maxSpan);
}

/** View options come back as `unknown`; a missing or wrong-typed value falls back. */
function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asSizeName(value: string): SizeName {
	return value in SIZE_STEPS ? (value as SizeName) : 'l';
}

function asTintName(value: string): TintName {
	return value === 'subtle' || value === 'strong' ? value : 'off';
}
