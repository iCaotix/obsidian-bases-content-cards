import {
	BasesEntry,
	BasesView,
	Component,
	MarkdownRenderer,
	SearchComponent,
	debounce,
	prepareSimpleSearch,
	renderMatches,
	type BasesPropertyId,
	type HoverPopover,
	type HoverParent,
	type QueryController,
	type SearchResult,
	type TFile,
	type WorkspaceLeaf,
} from 'obsidian';

import { createCard, type Card, type CardHost } from './cards';
import { ContentCache } from './contentCache';
import {
	basePathOf,
	findLeaf,
	memoryFor,
	nowhere,
	scrollToAnchor,
	topAnchor,
	type Anchor,
	type Place,
	type ViewMemory,
} from './memory';
import {
	ROW_HEIGHT,
	SIZE_STEPS,
	clampSpan,
	defaultParams,
	nextSpan,
	readParams,
	stepFromFileSize,
	type RenderParams,
} from './params';
import { excerptAround } from './search';
import { parseSelector, resolveSelector, stripMarkdown, truncate, type Selector } from './selector';

export const CONTENT_CARDS_VIEW = 'content-cards';

/**
 * How long to keep trying to put the reader back among the results of a restored
 * search. It takes as many attempts as the notes take to arrive, so it cannot be a
 * number of tries — but a note that never arrives must not leave a view
 * re-scrolling itself forever.
 */
const RESTORE_TIMEOUT = 5000;

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

export class ContentCardsView extends BasesView implements HoverParent {
	readonly type = CONTENT_CARDS_VIEW;
	hoverPopover: HoverPopover | null = null;

	private readonly rootEl: HTMLElement;
	private readonly resultsEl: HTMLElement;
	private readonly countEl: HTMLElement;
	/** Held so a restored query can be put back in the box the reader sees. */
	private readonly searchComponent: SearchComponent;
	private readonly cache: ContentCache;
	private readonly cardHost: CardHost;
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
	/**
	 * A restore that could not be carried out when it was asked for: under a search,
	 * the position only exists once the misses have been hidden, which needs the notes
	 * to have been read. Held, and re-applied on every fitting pass — each corrects by
	 * a delta, which is what makes repeating it converge.
	 */
	private pendingPlace: Place | null = null;
	/** When to give up on that, for a note that never arrives. */
	private pendingUntil = 0;
	/** Cards whose height may have changed since the last pass. */
	private readonly pending = new Set<Card>();
	private fitEverything = false;

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);

		this.rootEl = parentEl.createDiv('bcc-container');

		// The bar sits outside the part `onDataUpdated()` empties. A metadata event
		// mid-search would otherwise tear the input out from under the cursor.
		const searchEl = this.rootEl.createDiv('bcc-search');
		this.searchComponent = new SearchComponent(searchEl)
			.setPlaceholder('Search note contents…')
			.onChange(debounce((query: string) => this.setQuery(query), 200, true));
		this.countEl = searchEl.createDiv('bcc-search-count');

		this.resultsEl = this.rootEl.createDiv('bcc-results');

		// A restore in progress gives way to the reader: if they have started scrolling
		// on their own, being hauled back is worse than never being put there.
		for (const name of ['wheel', 'touchstart', 'keydown'] as const) {
			this.resultsEl.addEventListener(name, () => (this.pendingPlace = null), { passive: true });
		}

		// Recorded as it happens rather than once on the way out: by the time a view is
		// told it is being unloaded its element can already be detached, and a detached
		// element reports an offset of zero.
		this.resultsEl.addEventListener('scroll', () => this.rememberScroll(), { passive: true });

		this.cache = new ContentCache(this.app, (path) => this.fillCover(path));

		this.cardHost = {
			app: this.app,
			hoverParent: this,
			displayNameOf: (propertyId) => this.config.getDisplayName(propertyId),
			openInNewTab: () => this.params.newTab,
		};

		// Only read files whose cards are actually on screen. Because heights are
		// already known from file size, the scrollbar is correct regardless.
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const observed of entries) {
					const card = this.cardsByEl.get(observed.target);
					if (!card || card.filled) continue;

					// The shimmer is a promise that something is coming, and an animation
					// on every element wearing it whether or not anyone can see it. Off
					// screen that is paid every frame for nothing, so it is worn only by
					// the cards actually being read.
					card.coverEl.toggleClass('bcc-cover-loading', observed.isIntersecting);
					if (observed.isIntersecting) this.cache.request(card.file);
				}
			},
			{ root: null, rootMargin: '200px' },
		);

		// How tall a card needs to be depends on how wide its column is: the same
		// excerpt takes four lines in a narrow column and two in a wide one.
		this.resizeObserver = new ResizeObserver((entries) => {
			const width = entries[entries.length - 1]?.contentRect.width ?? 0;
			if (width === this.fittedWidth) return; // height-only change: nothing reflows
			this.fittedWidth = width;
			this.scheduleRefit();
		});
		this.resizeObserver.observe(this.resultsEl);

		// Rendered markdown does not finish when the renderer says it does: an <img>
		// has no height until it has loaded, so the height measured when `render()`
		// resolves is the height of the text without it. Watching the body catches
		// every such late arrival without having to enumerate what they might be.
		this.contentObserver = new ResizeObserver((entries) => {
			for (const observed of entries) {
				const cardEl = observed.target.closest('.bcc-card');
				const card = cardEl ? this.cardsByEl.get(cardEl) : undefined;
				if (card) this.scheduleFit(card);
			}
		});

		// A card painted before Obsidian finished indexing shows a cover built from an
		// empty metadata cache. Repaint it once the cache catches up — this also covers
		// a note being edited while the view is open.
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
		this.params = readParams(this.config);
		this.store = this.memory();
		this.restoreQuery();
		// One class for the whole view rather than one per card: nothing about these
		// varies per note.
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

		// A search that is already running has to be applied to the cards this rebuild
		// just produced, and any of them that were never read still have to be, or they
		// would count as "no match" for the wrong reason.
		if (this.matcher) this.readEverything();

		// A pass of its own, marking no card: the group headings and the count belong to
		// the grid rather than to any card in it, and a rebuild that ends with every card
		// hidden — or with no cards at all — leaves nobody to ask for one.
		this.scheduleFit();
		this.restoreScroll();
	}

	/** Cached because the answer cannot change: a view instance belongs to one tab. */
	private memory(): ViewMemory | null {
		this.leaf ??= findLeaf(this.app, this.rootEl);
		const basePath = basePathOf(this.leaf);

		return this.leaf && basePath !== null ? memoryFor(this.leaf, basePath, this.config.name) : null;
	}

	private rememberScroll(): void {
		this.store ??= this.memory();
		if (!this.store) return;

		// Two positions, because there are two places to come back to. While a search is
		// on the offset describes the results, and `place` is left holding the base
		// underneath it — untouched, so that emptying the box still has somewhere to go.
		if (this.matcher) this.store.queryPlace = this.currentPlace();
		else this.store.place = this.currentPlace();
	}

	/** Where the reader is now, in a form that outlives the cards it describes. */
	private currentPlace(): Place {
		const anchor = this.topAnchor();

		return {
			path: anchor?.card.file.path ?? null,
			offset: anchor?.offset ?? 0,
			top: this.resultsEl.scrollTop,
		};
	}

	private topAnchor(): Anchor | null {
		return topAnchor(this.resultsEl, (el) => this.cardsByEl.get(el));
	}

	/**
	 * Puts the reader back where they were — after a note was opened and closed, and
	 * equally after a rebuild triggered by an edit somewhere in the vault, which
	 * empties the grid and drops the offset just as thoroughly.
	 */
	private restoreScroll(): void {
		if (!this.store) return;

		// With a search restored there is nothing yet to put the reader back among, so
		// it is handed to the fitting pass, which keeps trying while the answers arrive.
		if (this.matcher) {
			this.pendingPlace = this.store.queryPlace;
			this.pendingUntil = Date.now() + RESTORE_TIMEOUT;
			return;
		}

		this.restorePlace(this.store.place);
	}

	/**
	 * The held restore, as an anchor, for as long as it is still worth attempting.
	 *
	 * It is given up on once every card has an answer — the grid has stopped losing
	 * rows above the target, so the last application of it was the right one — and on
	 * a deadline besides.
	 */
	private takePending(): Anchor | null {
		const place = this.pendingPlace;
		if (!place) return null;

		if (this.allFilled() || Date.now() > this.pendingUntil) this.pendingPlace = null;

		const card = place.path === null ? undefined : this.cardsByPath.get(place.path);

		return card ? { card, offset: place.offset } : null;
	}

	private allFilled(): boolean {
		for (const card of this.cardsByPath.values()) {
			if (!card.filled) return false;
		}

		return true;
	}

	/**
	 * Puts a remembered query back in the box, and back in force, when a tab returns
	 * to a grid it was searching. Only ever on a view that is not searching already: a
	 * data update mid-search must not disturb the box under the cursor.
	 */
	private restoreQuery(): void {
		const query = this.store?.query ?? '';
		if (query === '' || this.matcher) return;

		// The matcher first, so that the change handler this sets off sees a search
		// already in progress and treats itself as a continuation. Arriving there cold
		// would be the reader starting a search — which takes their place in the base,
		// and would overwrite it with wherever this half-built grid is sitting.
		this.matcher = prepareSimpleSearch(query);
		this.searchComponent.setValue(query);
		// `setValue` alone does not fire it, and the component wants it: without it the
		// box holds text that its own clear button does not believe is there.
		this.searchComponent.onChanged();
	}

	/**
	 * The note itself, if it is still in the grid. Every card around it already spans
	 * what it spanned before, so this lands where the reader left off rather than near
	 * it. A note that has since been filtered out, hidden or deleted leaves nothing
	 * better than the raw offset.
	 */
	private restorePlace(place: Place): void {
		const card = place.path === null ? undefined : this.cardsByPath.get(place.path);

		if (card) scrollToAnchor(this.resultsEl, { card, offset: place.offset });
		else this.resultsEl.scrollTop = place.top;
	}

	/**
	 * Bases has a search of its own, in the toolbar, and it already narrows the data
	 * we are handed — but it can only see the properties the view is showing, because
	 * that is all Bases itself can see. This one is the other half: the body of the
	 * note, which no Bases filter can reach.
	 */
	private setQuery(raw: string): void {
		const query = raw.trim();
		const wasSearching = this.matcher !== null;
		const searching = query !== '';

		this.matcher = searching ? prepareSimpleSearch(query) : null;

		this.store ??= this.memory();

		// A query the reader changed cancels a restore still in flight: it hides a
		// different set of cards, so a place held among the old results describes a list
		// that does not exist. The echo of a query this view just restored into its own
		// box is not a change.
		if (this.store?.query !== query) this.pendingPlace = null;

		if (this.store) this.store.query = query;

		// Starting a search hides most of the grid, and the browser clamps the offset to
		// whatever height is left — so the place is taken before the first card is
		// hidden, and the results are shown from their top. From here until the box is
		// emptied, scrolling writes to `queryPlace` and this survives the whole search.
		if (searching && !wasSearching && this.store) {
			this.store.place = this.currentPlace();
			this.store.queryPlace = nowhere();
			this.resultsEl.scrollTop = 0;
		}

		if (this.matcher) this.readEverything();
		for (const card of this.cardsByPath.values()) this.renderCover(card);

		// Emptying the box is the reader going back to the base, not arriving at it.
		// Restored while the cards are back but before the fitting pass runs, so that
		// the pass anchors on the card they came back to rather than pinning the top of
		// the list in place.
		if (!searching && wasSearching && this.store) this.restorePlace(this.store.place);

		this.scheduleFit();
	}

	/**
	 * Searching means every card has an answer to give, so the reading can no longer
	 * wait for a card to be scrolled into view. `request()` is idempotent, so a second
	 * query re-reads nothing.
	 */
	private readEverything(): void {
		for (const card of this.cardsByPath.values()) this.cache.request(card.file);
	}

	private renderCard(gridEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): void {
		const file = entry.file;
		const card = createCard(this.cardHost, gridEl, entry, order);

		this.setSpan(card, this.initialSpan(file));
		this.cardsByPath.set(file.path, card);
		this.cardsByEl.set(card.el, card);

		// A base is not restricted to notes — attachments come through as entries too,
		// and `cachedRead` on a PNG returns binary noise. There is nothing to read, so
		// the card skips straight to its final, smallest state. It can still be found by
		// name, which is all there is to find.
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
		if (cached === null) this.observer.observe(card.el);
		else this.paint(card, cached);
	}

	private initialSpan(file: TFile): number {
		if (this.params.uniform) return Math.min(this.params.maxSpan, SIZE_STEPS.m);

		// What this card was actually fitted to last time this tab drew this grid, in
		// preference to what its file size suggests. Still capped: the setting it was
		// measured under may have changed since.
		const fitted = this.store?.spans.get(file.path);

		return clampSpan(fitted ?? SIZE_STEPS[stepFromFileSize(file.stat.size)], this.params.maxSpan);
	}

	private setSpan(card: Card, span: number): void {
		card.span = span;
		card.el.style.gridRow = `span ${span}`;
		this.store?.spans.set(card.file.path, span);
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

		// Searched against with the markdown taken out, so that a hit is something the
		// reader could have seen: nobody is looking for `**`.
		card.haystack = stripMarkdown(region);
		card.filled = true;

		// It has nothing left to tell us, and an observer that keeps watching it keeps
		// recomputing its intersection on every scroll.
		this.observer.unobserve(card.el);

		this.renderCover(card);
	}

	/** Draws the cover in whichever of the two states the view is in. */
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
		// Only plain text carries its line breaks as characters; in rendered markdown
		// they are already elements, and honouring them twice would show every blank
		// line in the note as two.
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
				// A keystroke or a data update during the render has already replaced this
				// cover with another; the pass it wants is not about this any more.
				if (card.renderer === renderer) this.scheduleFit(card);
			});
			return;
		}

		card.bodyEl.setText(stripMarkdown(excerpt));
		this.scheduleFit(card);
	}

	/**
	 * The cover of a card that matched: the passage the hit is in, not the opening of
	 * the note. A card that says nothing about why it survived the search is worse
	 * than no card.
	 *
	 * Always plain text, even with markdown rendering on — the highlight has to be put
	 * around a range of characters, and after rendering those characters are spread
	 * across a tree. Obsidian's own search results are plain for the same reason.
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
	 * A note is found by its name as readily as by its body — that is the first thing
	 * anyone tries — so a title hit counts even when the body has none.
	 */
	private matchCard(card: Card, hit: SearchResult | null): boolean {
		const titleHit = this.matcher?.(card.file.basename) ?? null;
		const matched = !this.matcher || hit !== null || titleHit !== null;
		const wasHidden = card.el.hasClass('bcc-card-hidden');

		card.el.toggleClass('bcc-card-hidden', !matched);

		// A card entering or leaving the layout moves every card after it, which wants
		// the same answer a corrected height does: a pass, so that whatever is anchored
		// is put back afterwards. Nothing else asks for one on this path — a card that
		// turned out to be a miss returns below without a cover to draw.
		if (wasHidden === matched) this.schedulePass();

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
	 * Cards arrive in batches — one IntersectionObserver callback fills a screenful —
	 * so the pass is deferred to the next frame and covers every card at once, rather
	 * than reflowing the grid once per arriving note.
	 */
	private scheduleFit(card?: Card): void {
		if (card) this.pending.add(card);
		this.schedulePass();
	}

	/**
	 * Every card at once, for the one thing that changes all of their heights without
	 * touching any of them: the width of the columns.
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
	 * Only the cards that asked. Measuring the whole grid every time would make the
	 * cost of a pass grow with the number of cards already read — and the passes are
	 * most frequent exactly when that number is highest. Nothing makes a card's height
	 * depend on its neighbours.
	 */
	private fitAll(): void {
		// Taken while the layout is still the one the reader is looking at: every card
		// above the viewport that corrects its guess shifts everything below it, and
		// pinning one card on screen absorbs all of it. A held restore wins over what is
		// on screen, which until it is done is not where the reader is meant to be.
		const anchor = this.takePending() ?? this.topAnchor();

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

		if (anchor) scrollToAnchor(this.resultsEl, anchor);
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

	private fit({ card, needed, available }: Measurement): void {
		let granted = available;

		if (!this.params.uniform) {
			const next = nextSpan(card.span, needed, available, this.params.maxSpan);

			if (next !== card.span) {
				granted += (next - card.span) * ROW_HEIGHT;
				this.setSpan(card, next);
			}
		}

		// The fade at the bottom should mean "there is more", so it appears only where
		// the card was actually capped — by the maximum height or by uniform heights.
		// Fading out text that is complete just looks like a fault.
		card.coverEl.toggleClass('bcc-cover-clipped', needed > granted + 1);
	}
}
