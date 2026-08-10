import {
	BasesEntry,
	BasesView,
	Component,
	Keymap,
	MarkdownRenderer,
	SearchComponent,
	debounce,
	parsePropertyId,
	prepareSimpleSearch,
	renderMatches,
	type BasesPropertyId,
	type HoverParent,
	type HoverPopover,
	type PaneType,
	type QueryController,
	type SearchResult,
	type TFile,
	type WorkspaceLeaf,
} from 'obsidian';

import { ContentCache } from './contentCache';
import { excerptAround } from './search';
import { parseSelector, resolveSelector, stripMarkdown, truncate, type Selector } from './selector';

export const CONTENT_CARDS_VIEW = 'content-cards';

/**
 * Grid row height in px. Must match --bcc-row-height in styles.css, where row-gap
 * is deliberately 0 — any row gap would be inserted between every row of a span
 * and multiply the card's reserved height.
 */
const ROW_HEIGHT = 8;

/** Card heights in grid rows. */
const SIZE_STEPS = { s: 20, m: 30, l: 42, xl: 56 } as const;
export type SizeName = keyof typeof SIZE_STEPS;

/** How hard the per-note hue is mixed into a card. The rest lives in the stylesheet. */
export type TintName = 'off' | 'subtle' | 'strong';

/** Maximum-height setting that lets a card grow to whatever its cover needs. */
export const UNLIMITED = 'unlimited';

/**
 * How many hues the tint may pick from. Kept coarse on purpose: a hue taken from
 * the whole circle produces neighbours a few degrees apart, which at tint strength
 * are the same colour with extra steps. Twelve are each recognisably one colour.
 */
const TINT_HUES = 12;

/**
 * The hue a note is tinted with — from its path, not from its position, so that a
 * card keeps its colour when the base is re-sorted, re-filtered or reopened. A
 * colour that moved between notes would be worse than none: it would look like it
 * meant something.
 */
function hueFor(path: string): number {
	// FNV-1a. Sequential paths ("note 1", "note 2") differ in one low bit, and any
	// hash that carries that difference straight into the result would hand a whole
	// folder the same two colours. This one avalanches.
	let hash = 0x811c9dc5;
	for (let index = 0; index < path.length; index++) {
		hash ^= path.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return ((hash >>> 0) % TINT_HUES) * (360 / TINT_HUES);
}

/**
 * Byte thresholds for the initial height guess. `file.stat.size` is available
 * without touching the disk, which is the whole point: a card claims correctly
 * graded space before its text has been read, so nothing jumps once it arrives.
 */
function stepFromFileSize(bytes: number): SizeName {
	if (bytes < 600) return 's';
	if (bytes < 1800) return 'm';
	if (bytes < 4500) return 'l';
	return 'xl';
}

/**
 * What a tab knows about a grid it has shown before. Kept outside the view on
 * purpose: the view is exactly what does not survive the event this exists for.
 * Opening a note in the same tab replaces the tab's view, and coming back builds
 * a new one from nothing — so this has to be waiting for it somewhere else.
 *
 * Keyed by leaf, so two tabs on the same base each keep their own place, and
 * weakly, so a closed tab takes its entry with it.
 */
const memoryByLeaf = new WeakMap<WorkspaceLeaf, ViewMemory>();

interface ViewMemory {
	/** Which base and view this was taken in — a tab can navigate to another. */
	basePath: string;
	viewName: string;
	/** The note the reader was looking at, and where it sat. See `Anchor`. */
	anchorPath: string | null;
	anchorOffset: number;
	/** Only for when that note is gone from the data by the time we come back. */
	top: number;
	/**
	 * Every card's fitted span, by path. What a rebuilt grid otherwise has to guess
	 * from file size — and a guess is enough to keep the scrollbar honest while the
	 * notes are being read, but not to put the reader back on a card a thousand
	 * cards down: that position is the sum of every height above it, so it is also
	 * the sum of every error. These are the heights the same grid had a moment ago.
	 */
	spans: Map<string, number>;
}

/**
 * A card, and how far its top sits above the top edge of the viewport.
 *
 * The unit the grid is put back to, in place of a pixel offset. Every height in
 * this view is provisional — guessed from file size, corrected once the note is
 * read, corrected again at a new column width — so a pixel offset means a
 * different place in the list every time one of them changes, and the error is
 * the sum of every guess above it. A card is the same card regardless.
 */
interface Anchor {
	card: Card;
	offset: number;
}

interface Card {
	el: HTMLElement;
	/** The window: sized by the card, so its height is the space on offer. */
	coverEl: HTMLElement;
	/** The text: sized by itself, so its height is the space required. */
	bodyEl: HTMLElement;
	titleEl: HTMLElement;
	file: TFile;
	/**
	 * Owns whatever the markdown renderer built into this cover — image embeds,
	 * transclusions, and the listeners they come with. A cover is re-rendered every
	 * time its note changes and every time a search ends, and without something to
	 * unload the previous one, each of those leaves its predecessor loaded and
	 * listening on DOM that has already been thrown away.
	 */
	renderer: Component | null;
	span: number;
	filled: boolean;
	/**
	 * The cover's text with the markdown taken out, kept so that a keystroke costs
	 * one search over a string rather than re-reading and re-stripping the note.
	 * Null until the content arrives.
	 */
	haystack: string | null;
}

/** A group heading and its grid, so both can be hidden when a search empties it. */
interface GroupBlock {
	titleEl: HTMLElement | null;
	gridEl: HTMLElement;
}

type Matcher = (text: string) => SearchResult | null;

/** One card's two heights, read before any of them are written back. */
interface Measurement {
	card: Card;
	needed: number;
	available: number;
}

interface RenderParams {
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

export class ContentCardsView extends BasesView implements HoverParent {
	readonly type = CONTENT_CARDS_VIEW;
	hoverPopover: HoverPopover | null = null;

	private readonly rootEl: HTMLElement;
	private readonly resultsEl: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly cache: ContentCache;
	private readonly observer: IntersectionObserver;
	private readonly resizeObserver: ResizeObserver;
	private readonly contentObserver: ResizeObserver;
	private readonly cardsByPath = new Map<string, Card>();
	private readonly cardsByEl = new WeakMap<Element, Card>();
	private readonly groups: GroupBlock[] = [];
	private params: RenderParams = defaultParams();
	private matcher: Matcher | null = null;
	private fitHandle = 0;
	private fittedWidth = 0;
	private leaf: WorkspaceLeaf | null = null;
	private store: ViewMemory | null = null;
	/** Cards whose height may have changed since the last pass. */
	private readonly pending = new Set<Card>();
	private fitEverything = false;

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);

		this.rootEl = parentEl.createDiv('bcc-container');

		// The bar sits outside the part `onDataUpdated()` empties. A metadata event
		// mid-search would otherwise tear the input out from under the cursor.
		const searchEl = this.rootEl.createDiv('bcc-search');
		new SearchComponent(searchEl)
			.setPlaceholder('Search note contents…')
			.onChange(debounce((query: string) => this.setQuery(query), 200, true));
		this.countEl = searchEl.createDiv('bcc-search-count');

		this.resultsEl = this.rootEl.createDiv('bcc-results');
		// Recorded as it happens rather than once on the way out: by the time a view
		// is told it is being unloaded its element can already be detached, and a
		// detached element reports an offset of zero — which is precisely the answer
		// that would make this pointless.
		this.resultsEl.addEventListener('scroll', () => this.rememberScroll(), { passive: true });

		this.cache = new ContentCache(this.app, (path) => this.fillCover(path));

		// Only read files whose cards are actually on screen. Because heights are
		// already known from file size, the scrollbar is correct regardless.
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const observed of entries) {
					const card = this.cardsByEl.get(observed.target);
					if (!card || card.filled) continue;

					// The shimmer is a promise that something is coming — and an
					// animation on every element wearing it, whether or not anyone can
					// see it. A base of a few hundred notes hands out a few hundred of
					// them at once, and the ones off screen are pure cost: paid every
					// frame, for the whole time the view is open, for nothing. So it is
					// worn only by the cards actually being read.
					card.coverEl.toggleClass('bcc-cover-loading', observed.isIntersecting);
					if (observed.isIntersecting) this.cache.request(card.file);
				}
			},
			{ root: null, rootMargin: '200px' },
		);

		// How tall a card needs to be depends on how wide its column is: the same
		// excerpt takes four lines in a narrow column and two in a wide one. The
		// columns resize with the window, the sidebar and the pane, and a height
		// measured at the old width is wrong in both directions afterwards — too
		// tall once the column grew, too short once it shrank. So measure again.
		this.resizeObserver = new ResizeObserver((entries) => {
			const width = entries[entries.length - 1]?.contentRect.width ?? 0;
			if (width === this.fittedWidth) return; // height-only change: nothing reflows
			this.fittedWidth = width;
			this.scheduleRefit();
		});
		this.resizeObserver.observe(this.resultsEl);

		// Rendered markdown does not finish when the renderer says it does. An
		// <img> has no height until its file has loaded and decoded, and an embed
		// is resolved from the vault a beat later still — so the height measured
		// the moment `render()` resolves is the height of the text without them,
		// and `overflow: hidden` would then cut the picture off for good. Watching
		// the body catches every such late arrival, images included, without
		// having to enumerate what they might be.
		this.contentObserver = new ResizeObserver((entries) => {
			for (const observed of entries) {
				const cardEl = observed.target.closest('.bcc-card');
				const card = cardEl ? this.cardsByEl.get(cardEl) : undefined;
				if (card) this.scheduleFit(card);
			}
		});

		// A card painted before Obsidian finished indexing shows a cover built from
		// an empty metadata cache. Repaint it once the cache catches up — this also
		// covers a note being edited while the view is open.
		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.repaint(file.path)));
	}

	private repaint(path: string): void {
		const card = this.cardsByPath.get(path);
		if (!card) return;

		this.cache.invalidate(path);
		card.filled = false;
		this.cache.request(card.file);
	}

	override onunload(): void {
		this.observer.disconnect();
		this.resizeObserver.disconnect();
		this.contentObserver.disconnect();
		this.rootEl.ownerDocument.defaultView?.cancelAnimationFrame(this.fitHandle);
		this.cache.clear();
		super.onunload();
	}

	public onDataUpdated(): void {
		this.params = this.readParams();
		this.store = this.memory();
		// One class for the whole view rather than one per card: nothing about it
		// varies per note, and a wrapped title only changes how tall the footer is —
		// which the fitting pass reads back off the cover either way.
		this.resultsEl.toggleClass('bcc-wrap-titles', this.params.wrapTitle);
		this.resultsEl.toggleClass('bcc-tint-subtle', this.params.tint === 'subtle');
		this.resultsEl.toggleClass('bcc-tint-strong', this.params.tint === 'strong');
		this.observer.disconnect();
		this.contentObserver.disconnect(); // the elements it holds are about to go
		for (const card of this.cardsByPath.values()) this.disposeRenderer(card);
		this.cardsByPath.clear();
		this.pending.clear(); // cards from the grid being replaced, about to be detached
		this.groups.length = 0;
		this.resultsEl.empty();

		const order = this.config.getOrder();

		for (const group of this.data.groupedData) {
			const titleEl = group.hasKey()
				? this.resultsEl.createDiv('bcc-group-title', (el) => el.setText(group.key?.toString() ?? ''))
				: null;

			const gridEl = this.resultsEl.createDiv('bcc-grid');
			this.groups.push({ titleEl, gridEl });

			for (const entry of group.entries) {
				this.renderCard(gridEl, entry, order);
			}
		}

		// A search that is already running has to be applied to the cards this
		// rebuild just produced, and any of them that were never read still have
		// to be, or they would count as "no match" for the wrong reason.
		if (this.matcher) this.readEverything();

		// A pass of its own, marking no card: the group headings and the count belong
		// to the grid rather than to any card in it, and a rebuild that ends with
		// every card hidden — or with no cards at all — leaves nobody to ask for one.
		this.scheduleFit();
		this.restoreScroll();
	}

	/**
	 * The tab this view is drawn in. Found through the DOM because nothing hands a
	 * Bases view its leaf, and cached because the answer cannot change: a view
	 * instance belongs to one tab for its whole life.
	 */
	private findLeaf(): WorkspaceLeaf | null {
		if (this.leaf) return this.leaf;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!this.leaf && leaf.view.containerEl.contains(this.rootEl)) this.leaf = leaf;
		});

		return this.leaf;
	}

	/**
	 * This tab's memory of this grid, kept across the note that is about to replace
	 * it. A tab that has navigated to a different base — or to another view of the
	 * same one — starts a new one: what it remembered describes a layout that is no
	 * longer on screen.
	 */
	private memory(): ViewMemory | null {
		const leaf = this.findLeaf();
		const basePath = basePathOf(leaf);
		if (!leaf || basePath === null) return null;

		const kept = memoryByLeaf.get(leaf);
		if (kept && kept.basePath === basePath && kept.viewName === this.config.name) return kept;

		const fresh: ViewMemory = {
			basePath,
			viewName: this.config.name,
			anchorPath: null,
			anchorOffset: 0,
			top: 0,
			spans: new Map(),
		};
		memoryByLeaf.set(leaf, fresh);

		return fresh;
	}

	private rememberScroll(): void {
		this.store ??= this.memory();
		if (!this.store) return;

		const anchor = this.topAnchor();
		this.store.anchorPath = anchor?.card.file.path ?? null;
		this.store.anchorOffset = anchor?.offset ?? 0;
		this.store.top = this.resultsEl.scrollTop;
	}

	/**
	 * The card at the top edge of the viewport, and how far it has already scrolled
	 * past it.
	 *
	 * Hit-tested rather than searched: this runs on every scroll event, and walking
	 * a grid of several hundred cards for the first one still on screen would cost a
	 * rect read each, all of them above the one being looked for.
	 */
	private topAnchor(): Anchor | null {
		const bounds = this.resultsEl.getBoundingClientRect();
		const doc = this.resultsEl.ownerDocument;

		// One point is not enough. Across: columns are separated by a gutter, and a
		// card that ends higher than its neighbours leaves the space beneath it empty.
		// Down: a group heading, or the grid's own padding, can own the top edge
		// outright. Whichever card is found, the offset is measured from its own box,
		// so probing lower only makes one easier to find — it does not move it.
		for (const depth of [1, 24, 72]) {
			for (const fraction of [0.5, 0.15, 0.85, 0.3, 0.7]) {
				const found = doc.elementFromPoint(bounds.left + bounds.width * fraction, bounds.top + depth);
				const cardEl = found?.closest('.bcc-card');
				const card = cardEl ? this.cardsByEl.get(cardEl) : undefined;
				if (card && cardEl) return { card, offset: bounds.top - cardEl.getBoundingClientRect().top };
			}
		}

		return null;
	}

	/**
	 * Put a card back where it was, whatever has happened to the heights above it.
	 * Correcting the scroll offset by the difference, rather than computing an
	 * absolute one, is what makes this independent of everything else on the page.
	 */
	private scrollToAnchor({ card, offset }: Anchor): void {
		if (!card.el.isConnected || card.el.hasClass('bcc-card-hidden')) return;

		const delta = card.el.getBoundingClientRect().top - this.resultsEl.getBoundingClientRect().top + offset;
		if (delta !== 0) this.resultsEl.scrollTop += delta;
	}

	/**
	 * Put the reader back where they were — after a note was opened and closed, and
	 * equally after a rebuild triggered by an edit somewhere in the vault, which
	 * empties the grid and drops the offset just as thoroughly.
	 *
	 * Only for the base and view the offset was taken in: a tab that has since
	 * navigated to a different base has a scroll position, but not this one.
	 */
	private restoreScroll(): void {
		const saved = this.store;
		if (!saved) return;

		const card = saved.anchorPath === null ? undefined : this.cardsByPath.get(saved.anchorPath);

		// The note itself, if it is still in the base. Every card around it already
		// spans what it spanned before, so this lands where the reader left off
		// rather than near it. A note that has since been filtered out or deleted
		// leaves nothing better than the raw offset.
		if (card) this.scrollToAnchor({ card, offset: saved.anchorOffset });
		else this.resultsEl.scrollTop = saved.top;
	}

	/**
	 * Bases has a search of its own, in the toolbar, and it already narrows the
	 * data we are handed — but it can only see the properties the view is showing
	 * (`config.getOrder()`), because that is all Bases itself can see. This one is
	 * the other half: the body of the note, which no Bases filter can reach.
	 */
	private setQuery(raw: string): void {
		const query = raw.trim();
		this.matcher = query === '' ? null : prepareSimpleSearch(query);

		if (this.matcher) this.readEverything();
		for (const card of this.cardsByPath.values()) this.renderCover(card);
		this.scheduleFit();
	}

	/**
	 * Searching means every card has an answer to give, so the reading can no
	 * longer wait for a card to be scrolled into view. This is the one place that
	 * cost is paid; `request()` is idempotent and the cache is shared, so a second
	 * query re-reads nothing.
	 */
	private readEverything(): void {
		for (const card of this.cardsByPath.values()) this.cache.request(card.file);
	}

	private readParams(): RenderParams {
		const maxSize = asString(this.config.get('maxSize'), 'l');
		const maxSpan = maxSize === UNLIMITED ? Number.POSITIVE_INFINITY : SIZE_STEPS[asSizeName(maxSize)];

		return {
			selector: parseSelector(asString(this.config.get('coverSelector'), ':')) ?? { kind: 'body' },
			selectorProperty: this.config.getAsPropertyId('selectorProperty'),
			maxLength: asNumber(this.config.get('maxLength'), 300),
			markdown: this.config.get('renderMarkdown') === true,
			wrapTitle: this.config.get('wrapTitle') === true,
			newTab: this.config.get('openInNewTab') === true,
			tint: asTintName(asString(this.config.get('cardTint'), 'off')),
			uniform: this.config.get('cardSize') === 'uniform',
			maxSpan,
		};
	}

	private renderCard(gridEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): void {
		const file = entry.file;
		const cardEl = gridEl.createDiv('bcc-card');
		// Set whether or not tinting is on: it costs a string, and the stylesheet is
		// then the only thing that has to know what "off" looks like.
		cardEl.style.setProperty('--bcc-hue', String(hueFor(file.path)));
		const coverEl = cardEl.createDiv('bcc-cover');
		const bodyEl = coverEl.createDiv('bcc-cover-body');

		const card: Card = {
			el: cardEl,
			coverEl,
			bodyEl,
			titleEl: this.renderFooter(cardEl, entry, order),
			file,
			span: SIZE_STEPS.m,
			filled: false,
			haystack: null,
			renderer: null,
		};

		this.setSpan(card, this.initialSpan(file));
		this.makeOpenable(cardEl, file);

		this.cardsByPath.set(file.path, card);
		this.cardsByEl.set(cardEl, card);

		// A base is not restricted to notes — attachments come through as entries
		// too, and `cachedRead` on a PNG returns binary noise. There is nothing to
		// read, so the card skips straight to its final, smallest state. It can
		// still be found by name, which is all there is to find.
		if (file.extension !== 'md') {
			this.setSpan(card, Math.min(this.params.maxSpan, SIZE_STEPS.s));
			card.bodyEl.addClass('bcc-cover-none');
			card.filled = true;
			card.haystack = '';
			this.matchCard(card, null);
			return;
		}

		const cached = this.cache.get(file);
		// The shimmer waits for the observer: a card nowhere near the viewport is not
		// being read, so it has nothing to promise. See the observer's callback.
		if (cached === null) this.observer.observe(cardEl);
		else this.paint(card, cached);
	}

	private initialSpan(file: TFile): number {
		if (this.params.uniform) return Math.min(this.params.maxSpan, SIZE_STEPS.m);

		// What this card was actually fitted to last time this tab drew this grid,
		// in preference to what its file size suggests. Still capped: the setting it
		// was measured under may have changed since. If the column width changed
		// while the note was open, the fitting pass corrects it as usual.
		const fitted = this.store?.spans.get(file.path);
		const span = fitted ?? SIZE_STEPS[stepFromFileSize(file.stat.size)];

		return Math.min(this.params.maxSpan, Math.max(SIZE_STEPS.s, span));
	}

	private setSpan(card: Card, span: number): void {
		card.span = span;
		card.el.style.gridRow = `span ${span}`;
		this.store?.spans.set(card.file.path, span);
	}

	/**
	 * The whole card opens its note — cover, title and properties alike. Two things
	 * must still get through: links inside a markdown-rendered cover belong to
	 * Obsidian, and a click that ends a text selection is not a click on the card.
	 */
	private makeOpenable(cardEl: HTMLElement, file: TFile): void {
		const open = (evt: MouseEvent) => {
			if (evt.button !== 0 && evt.button !== 1) return;

			const link = (evt.target as HTMLElement).closest('a');
			if (link && !link.hasClass('bcc-title')) return;

			const selection = cardEl.ownerDocument.defaultView?.getSelection();
			if (selection && !selection.isCollapsed && cardEl.contains(selection.anchorNode)) return;

			evt.preventDefault();

			// The modifier decides when there is one — it can also ask for a split,
			// which the option has no way to express and no business overriding.
			// Failing that, a middle click or the option opens a tab.
			let target: PaneType | boolean = Keymap.isModEvent(evt);
			if (target === false && (evt.button === 1 || this.params.newTab)) target = 'tab';

			void this.app.workspace.openLinkText(file.path, '', target);
		};

		cardEl.addEventListener('click', open);
		cardEl.addEventListener('auxclick', open); // middle click does not fire 'click'
	}

	/** Returns the title element, which a search has to be able to highlight. */
	private renderFooter(cardEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): HTMLElement {
		const footerEl = cardEl.createDiv('bcc-footer');

		const titleEl = footerEl.createEl('a', { cls: 'bcc-title', text: entry.file.basename });
		titleEl.addEventListener('mouseover', (evt) => {
			this.app.workspace.trigger('hover-link', {
				event: evt,
				source: 'bases',
				hoverParent: this,
				targetEl: titleEl,
				linktext: entry.file.path,
			});
		});

		const propsEl = footerEl.createDiv('bcc-props');
		for (const propertyId of order) {
			const { type, name } = parsePropertyId(propertyId);
			if (type === 'file' && name === 'name') continue; // already the title

			const value = entry.getValue(propertyId);
			if (!value || !value.isTruthy()) continue;

			propsEl.createDiv('bcc-prop', (el) => {
				el.createSpan({ cls: 'bcc-prop-label', text: this.config.getDisplayName(propertyId) });
				el.createSpan({ cls: 'bcc-prop-value', text: value.toString() });
			});
		}

		return titleEl;
	}

	/** Called once the cache has the file, possibly long after the card was drawn. */
	private fillCover(path: string): void {
		const card = this.cardsByPath.get(path);
		if (!card) return;

		const text = this.cache.get(card.file);
		if (text === null) return;

		this.paint(card, text);
	}

	private paint(card: Card, content: string): void {
		const cache = this.app.metadataCache.getFileCache(card.file);
		const region = resolveSelector(content, cache, this.selectorFor(card, this.params.selector));

		// Searched against with the markdown taken out, so that a hit is something
		// the reader could have seen: nobody is looking for `**`, and a query would
		// otherwise match syntax that the plain cover never shows.
		card.haystack = stripMarkdown(region);
		card.filled = true;

		// It has nothing left to tell us, and an observer that keeps watching it keeps
		// recomputing its intersection on every scroll, along with every other card
		// the reader has already been past.
		this.observer.unobserve(card.el);

		this.renderCover(card);
	}

	/**
	 * Draws the cover in whichever of the two states the view is in. Split from
	 * `paint()` because a keystroke changes only this half — the note has already
	 * been read, resolved and stripped by then.
	 */
	private renderCover(card: Card): void {
		if (!card.filled || card.haystack === null) return;

		const hit = this.matcher?.(card.haystack) ?? null;
		if (!this.matchCard(card, hit)) return;

		this.disposeRenderer(card);
		card.bodyEl.empty();
		card.coverEl.removeClass('bcc-cover-loading');

		if (this.matcher) {
			this.renderMatchedCover(card, hit);
			return;
		}

		const content = this.cache.get(card.file);
		if (content === null) return;

		const cache = this.app.metadataCache.getFileCache(card.file);
		const region = resolveSelector(content, cache, this.selectorFor(card, this.params.selector));
		const excerpt = truncate(region, this.params.maxLength);

		card.bodyEl.toggleClass('bcc-cover-empty', excerpt === '');
		// Only plain text carries its line breaks as characters; in rendered
		// markdown they are already elements, and honouring them twice would show
		// every blank line in the note as two.
		card.bodyEl.toggleClass('bcc-cover-plain', !this.params.markdown);

		if (excerpt === '') {
			this.scheduleFit(card);
			return;
		}

		if (this.params.markdown) {
			this.contentObserver.observe(card.bodyEl);

			const renderer = this.addChild(new Component());
			card.renderer = renderer;
			void MarkdownRenderer.render(this.app, excerpt, card.bodyEl, card.file.path, renderer).then(() => {
				// A keystroke or a data update during the render has already replaced
				// this cover with another; the pass it wants is not about this any more.
				if (card.renderer === renderer) this.scheduleFit(card);
			});
			return;
		}

		card.bodyEl.setText(stripMarkdown(excerpt));
		this.scheduleFit(card);
	}

	/**
	 * The cover of a card that matched: the passage the hit is in, not the opening
	 * of the note. A card that says nothing about why it survived the search is
	 * worse than no card.
	 *
	 * Always plain text, even with markdown rendering on — the highlight has to be
	 * put around a range of characters, and after rendering those characters are
	 * spread across a tree. Obsidian's own search results are plain for the same
	 * reason.
	 */
	private renderMatchedCover(card: Card, hit: SearchResult | null): void {
		const excerpt = excerptAround(card.haystack ?? '', hit?.matches ?? [], this.params.maxLength);

		card.bodyEl.toggleClass('bcc-cover-empty', excerpt.text === '');
		card.bodyEl.addClass('bcc-cover-plain');
		renderMatches(card.bodyEl, excerpt.text, excerpt.matches);

		this.scheduleFit(card);
	}

	/**
	 * Decides whether a card belongs in the current search, and marks up its title.
	 * Returns whether the cover is worth drawing at all.
	 *
	 * A note is found by its name as readily as by its body — that is the first
	 * thing anyone tries — so a title hit counts even when the body has none.
	 */
	private matchCard(card: Card, hit: SearchResult | null): boolean {
		const titleHit = this.matcher?.(card.file.basename) ?? null;
		const matched = !this.matcher || hit !== null || titleHit !== null;

		card.el.toggleClass('bcc-card-hidden', !matched);

		card.titleEl.empty();
		if (titleHit) renderMatches(card.titleEl, card.file.basename, titleHit.matches);
		else card.titleEl.setText(card.file.basename);

		return matched;
	}

	/** A note may override the view-wide selector through a property. */
	private selectorFor(card: Card, fallback: Selector): Selector {
		const propertyId = this.params.selectorProperty;
		if (!propertyId) return fallback;

		const entry = this.data.data.find((candidate) => candidate.file.path === card.file.path);
		const raw = entry?.getValue(propertyId)?.toString();

		return parseSelector(raw) ?? fallback;
	}

	/**
	 * Correcting the file-size guess, and the answer to a resize, are the same
	 * job: measure, then span what the text needs. Cards arrive in batches — one
	 * IntersectionObserver callback fills a screenful — so the pass is deferred
	 * to the next frame and covers every card at once, rather than reflowing the
	 * grid once per arriving note.
	 */
	private scheduleFit(card?: Card): void {
		if (card) this.pending.add(card);
		this.schedulePass();
	}

	/**
	 * Every card at once, for the one thing that changes all of their heights
	 * without touching any of them: the width of the columns.
	 */
	private scheduleRefit(): void {
		this.fitEverything = true;
		this.schedulePass();
	}

	private schedulePass(): void {
		if (this.fitHandle !== 0) return;

		// The card's own window, so this still works when the view is in a popout.
		const win = this.rootEl.ownerDocument.defaultView;
		if (!win) return;

		this.fitHandle = win.requestAnimationFrame(() => {
			this.fitHandle = 0;
			this.fitAll();
		});
	}

	/**
	 * Read every height first, then write every span: interleaving the two forces a
	 * layout per card.
	 *
	 * Only the cards that asked. Scrolling through a large base fills card after
	 * card, and each arrival schedules a pass — so measuring the whole grid every
	 * time means the cost of a pass grows with the number of cards already read,
	 * and the passes are most frequent exactly when that number is highest. Nothing
	 * makes a card's height depend on its neighbours: it spans the rows it was
	 * given, and they span theirs.
	 */
	private fitAll(): void {
		// Taken with the measurements, while the layout is still the one the reader is
		// looking at. Every card above the viewport that corrects its guess shifts
		// everything below it — which is the whole list sliding under the reader.
		// Pinning one card on screen absorbs all of it.
		const anchor = this.topAnchor();

		const due = this.fitEverything ? this.cardsByPath.values() : this.pending;
		const measurements: Measurement[] = [];

		for (const card of due) {
			// A card left over from a grid that has since been replaced measures zero,
			// which is not a height — and would be written back as one, into the spans
			// this tab remembers for the next time it draws this base.
			if (!card.el.isConnected) continue;
			if (!card.filled || card.el.hasClass('bcc-card-hidden')) continue; // no layout to measure
			measurements.push({ card, needed: card.bodyEl.offsetHeight, available: card.coverEl.clientHeight });
		}

		this.pending.clear();
		this.fitEverything = false;

		for (const measurement of measurements) this.fit(measurement);

		this.reconcileGroups();
		this.updateCount();

		if (anchor) this.scrollToAnchor(anchor);
	}

	/** Unloads the previous rendering of a cover, and everything it registered. */
	private disposeRenderer(card: Card): void {
		if (!card.renderer) return;

		this.removeChild(card.renderer);
		card.renderer = null;
	}

	/** Counted rather than tracked, because a card can be hidden from several places. */
	private updateCount(): void {
		if (!this.matcher) {
			this.countEl.setText('');
			return;
		}

		let shown = 0;
		for (const card of this.cardsByPath.values()) {
			if (!card.el.hasClass('bcc-card-hidden')) shown++;
		}

		this.countEl.setText(`${shown} of ${this.cardsByPath.size}`);
	}

	/** A group whose cards were all filtered out should take its heading with it. */
	private reconcileGroups(): void {
		for (const group of this.groups) {
			const empty = group.gridEl.querySelector('.bcc-card:not(.bcc-card-hidden)') === null;
			group.titleEl?.toggleClass('bcc-hidden', empty);
			group.gridEl.toggleClass('bcc-hidden', empty);
		}
	}

	/**
	 * `available` is what the card currently grants its cover, `needed` what the
	 * text wants — an absolute pair, not a delta from the last pass, so repeating
	 * this at a new width converges in one go and can shrink a card as readily as
	 * it grows one. Rows are granted by rounding up: half a row of slack looks
	 * like nothing, half a row of missing text looks like a bug.
	 */
	private fit({ card, needed, available }: Measurement): void {
		let granted = available;

		if (!this.params.uniform) {
			const deltaRows = Math.ceil((needed - available) / ROW_HEIGHT);
			const next = Math.min(this.params.maxSpan, Math.max(SIZE_STEPS.s, card.span + deltaRows));

			if (next !== card.span) {
				granted += (next - card.span) * ROW_HEIGHT;
				this.setSpan(card, next);
			}
		}

		// The fade at the bottom should mean "there is more", so it appears only
		// where the card was actually capped — by the maximum height or by uniform
		// heights. Fading out text that is complete just looks like a fault.
		card.coverEl.toggleClass('bcc-cover-clipped', needed > granted + 1);
	}
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

/**
 * The base file a tab is showing, or null when this view has no tab of its own.
 * An embedded base lives in its note's leaf, and keying on the note would have two
 * embeds in one note fighting over a single remembered offset.
 */
function basePathOf(leaf: WorkspaceLeaf | null): string | null {
	const file: unknown = leaf?.getViewState().state?.file;
	return typeof file === 'string' && file.endsWith('.base') ? file : null;
}

function asTintName(value: string): TintName {
	return value === 'subtle' || value === 'strong' ? value : 'off';
}

function defaultParams(): RenderParams {
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
