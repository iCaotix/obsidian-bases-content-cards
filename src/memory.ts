import type { App, WorkspaceLeaf } from 'obsidian';

import type { Card } from './cards';

/**
 * Where the reader is, as a note and an offset rather than a pixel.
 *
 * Every height in this view is provisional — guessed from file size, corrected
 * once the note is read, corrected again at a new column width — so a pixel offset
 * means a different place in the list every time one of them changes, and the error
 * is the sum of every guess above it. A card is the same card regardless.
 */
export interface Place {
	path: string | null;
	offset: number;
	/** Only for when that note is not in the grid to be found. */
	top: number;
}

/** A `Place` resolved against the cards currently on screen. */
export interface Anchor {
	card: Card;
	offset: number;
}

/**
 * What a tab knows about a grid it has shown before. Kept outside the view on
 * purpose: the view is exactly what does not survive the event this exists for.
 * Opening a note in the same tab replaces the tab's view, and coming back builds a
 * new one from nothing — so this has to be waiting for it somewhere else.
 */
export interface ViewMemory {
	/** Which base and view this was taken in — a tab can navigate to another. */
	basePath: string;
	viewName: string;
	/**
	 * Where the reader was in the grid with nothing hidden. Held still for as long
	 * as a search is on: that is the place the search interrupted, and the place
	 * emptying the box goes back to.
	 */
	place: Place;
	/** What was in the search box, and where the reader was among what it found. */
	query: string;
	queryPlace: Place;
	/**
	 * Every card's fitted span, by path — the heights the same grid had a moment
	 * ago. A file-size guess keeps the scrollbar honest, but it cannot put the
	 * reader back on a card a thousand cards down: that position is the sum of
	 * every height above it, so it is also the sum of every error.
	 */
	spans: Map<string, number>;
}

/**
 * Keyed by leaf, so two tabs on the same base each keep their own place, and
 * weakly, so a closed tab takes its entry with it.
 */
const memoryByLeaf = new WeakMap<WorkspaceLeaf, ViewMemory>();

/** No note, no offset: the top of the grid. */
export function nowhere(): Place {
	return { path: null, offset: 0, top: 0 };
}

/**
 * This tab's memory of this grid, kept across the note that is about to replace it.
 * A tab that has navigated to a different base — or to another view of the same one
 * — starts a new one: what it remembered describes a layout that is no longer on
 * screen.
 */
export function memoryFor(leaf: WorkspaceLeaf, basePath: string, viewName: string): ViewMemory {
	const kept = memoryByLeaf.get(leaf);
	if (kept && kept.basePath === basePath && kept.viewName === viewName) return kept;

	const fresh: ViewMemory = {
		basePath,
		viewName,
		place: nowhere(),
		query: '',
		queryPlace: nowhere(),
		spans: new Map(),
	};
	memoryByLeaf.set(leaf, fresh);

	return fresh;
}

/** The tab a view is drawn in. Found through the DOM: nothing hands a Bases view its leaf. */
export function findLeaf(app: App, el: HTMLElement): WorkspaceLeaf | null {
	let found: WorkspaceLeaf | null = null;

	app.workspace.iterateAllLeaves((leaf) => {
		if (!found && leaf.view.containerEl.contains(el)) found = leaf;
	});

	return found;
}

/**
 * The base file a tab is showing, or null when this view has no tab of its own.
 * An embedded base lives in its note's leaf, and keying on the note would have two
 * embeds in one note fighting over a single remembered offset.
 */
export function basePathOf(leaf: WorkspaceLeaf | null): string | null {
	const file: unknown = leaf?.getViewState().state?.file;
	return typeof file === 'string' && file.endsWith('.base') ? file : null;
}

/**
 * The card at the top edge of the viewport, and how far it has already scrolled
 * past it.
 *
 * Hit-tested rather than searched: this runs on every scroll event, and walking a
 * grid of several hundred cards for the first one still on screen would cost a rect
 * read each, all of them above the one being looked for.
 */
export function topAnchor(resultsEl: HTMLElement, cardFor: (el: Element) => Card | undefined): Anchor | null {
	const bounds = resultsEl.getBoundingClientRect();
	const doc = resultsEl.ownerDocument;

	// One point is not enough. Across: columns are separated by a gutter, and a card
	// that ends higher than its neighbours leaves the space beneath it empty. Down: a
	// group heading, or the grid's own padding, can own the top edge outright. The
	// offset is measured from whichever card is found, so probing lower only makes
	// one easier to find — it does not move it.
	for (const depth of [1, 24, 72]) {
		for (const fraction of [0.5, 0.15, 0.85, 0.3, 0.7]) {
			const found = doc.elementFromPoint(bounds.left + bounds.width * fraction, bounds.top + depth);
			const cardEl = found?.closest('.bcc-card');
			const card = cardEl ? cardFor(cardEl) : undefined;
			if (card && cardEl) return { card, offset: bounds.top - cardEl.getBoundingClientRect().top };
		}
	}

	return null;
}

/**
 * Puts a card back where it was, whatever has happened to the heights above it.
 * Correcting the scroll offset by the difference, rather than computing an absolute
 * one, is what makes this independent of everything else on the page.
 */
export function scrollToAnchor(resultsEl: HTMLElement, { card, offset }: Anchor): void {
	if (!card.el.isConnected || card.el.hasClass('bcc-card-hidden')) return;

	const delta = card.el.getBoundingClientRect().top - resultsEl.getBoundingClientRect().top + offset;
	if (delta !== 0) resultsEl.scrollTop += delta;
}
