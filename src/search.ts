/**
 * Choosing which part of a note to show for a search hit.
 *
 * No Obsidian imports, same as `selector.ts`: offset arithmetic is where this kind
 * of code goes wrong, and it is far cheaper to pin down in `node --test` than in a
 * running vault. `prepareSimpleSearch` supplies the ranges and `renderMatches`
 * draws them; everything in between is here.
 */

/** A `[from, to)` range, in the same shape Obsidian's search returns. */
export type MatchRange = [number, number];

export interface Excerpt {
	text: string;
	/** The ranges, moved into `text`'s coordinates. Ready to hand to `renderMatches`. */
	matches: MatchRange[];
}

/** How much of the window is spent on what comes *before* the first hit. */
const LEAD = 0.3;

/** A word boundary is worth having, but not at the price of hiding the hit. */
const SNAP = 20;

/**
 * A window of `text` no longer than `maxLength` that contains the first match,
 * with the match ranges translated into it.
 *
 * The point is the case the plain cover cannot handle: a note whose hit sits two
 * pages down still has to show *why* it matched, so the window travels to the hit.
 * A hit already inside the plain excerpt leaves the window where it is — moving it
 * would make the card stop looking like itself for no gain.
 */
export function excerptAround(text: string, matches: MatchRange[], maxLength: number): Excerpt {
	const { start, end } = windowFor(text, matches, maxLength);

	const raw = text.slice(start, end);
	const lead = raw.length - raw.trimStart().length;
	const body = raw.trim();

	const head = start > 0 ? '…' : '';
	const tail = end < text.length ? '…' : '';

	// An absolute offset in `text` lands at `offset + shift` in what we render:
	// back by everything the window dropped, forward by the leading ellipsis.
	const shift = head.length - start - lead;
	const moved: MatchRange[] = [];

	for (const [from, to] of matches) {
		// Clipped, not dropped: a hit the window only half covers is still worth
		// marking, and a range reaching past the text would throw off the render.
		const clippedFrom = Math.max(from + shift, head.length);
		const clippedTo = Math.min(to + shift, head.length + body.length);
		if (clippedFrom < clippedTo) moved.push([clippedFrom, clippedTo]);
	}

	return { text: head + body + tail, matches: moved };
}

function windowFor(text: string, matches: MatchRange[], maxLength: number): { start: number; end: number } {
	if (maxLength <= 0 || text.length <= maxLength) return { start: 0, end: text.length };

	const first = earliest(matches);

	// Already visible in the plain excerpt, or nothing matched: stay at the top.
	if (first === null || first[1] <= maxLength) return { start: 0, end: cutEnd(text, 0, maxLength, first) };

	const start = wordStart(text, Math.max(0, first[0] - Math.floor(maxLength * LEAD)));
	return { start, end: cutEnd(text, start, Math.min(text.length, start + maxLength), first) };
}

/** The search does not promise an order, and the window is built around the first hit. */
function earliest(matches: MatchRange[]): MatchRange | null {
	let first: MatchRange | null = null;
	for (const match of matches) {
		if (first === null || match[0] < first[0]) first = match;
	}
	return first;
}

/** Ends on a word boundary when there is one nearby that does not cut into the hit. */
function cutEnd(text: string, start: number, end: number, first: MatchRange | null): number {
	if (end >= text.length) return text.length;

	const space = text.lastIndexOf(' ', end);
	const floor = Math.max(first?.[1] ?? 0, start + Math.floor((end - start) * 0.6));

	return space > floor ? space : end;
}

/** Starts on a word boundary, as long as one is close enough to be worth it. */
function wordStart(text: string, index: number): number {
	if (index <= 0) return 0;

	const space = text.indexOf(' ', index);
	return space === -1 || space > index + SNAP ? index : space + 1;
}
