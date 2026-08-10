import {
	BasesEntry,
	BasesView,
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
	type QueryController,
	type SearchResult,
	type TFile,
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

/** Maximum-height setting that lets a card grow to whatever its cover needs. */
export const UNLIMITED = 'unlimited';

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

interface Card {
	el: HTMLElement;
	/** The window: sized by the card, so its height is the space on offer. */
	coverEl: HTMLElement;
	/** The text: sized by itself, so its height is the space required. */
	bodyEl: HTMLElement;
	titleEl: HTMLElement;
	file: TFile;
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
		this.cache = new ContentCache(this.app, (path) => this.fillCover(path));

		// Only read files whose cards are actually on screen. Because heights are
		// already known from file size, the scrollbar is correct regardless.
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const observed of entries) {
					if (!observed.isIntersecting) continue;
					const card = this.cardsByEl.get(observed.target);
					if (card && !card.filled) this.cache.request(card.file);
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
			this.scheduleFit();
		});
		this.resizeObserver.observe(this.resultsEl);

		// Rendered markdown does not finish when the renderer says it does. An
		// <img> has no height until its file has loaded and decoded, and an embed
		// is resolved from the vault a beat later still — so the height measured
		// the moment `render()` resolves is the height of the text without them,
		// and `overflow: hidden` would then cut the picture off for good. Watching
		// the body catches every such late arrival, images included, without
		// having to enumerate what they might be.
		this.contentObserver = new ResizeObserver(() => this.scheduleFit());

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
		this.observer.disconnect();
		this.contentObserver.disconnect(); // the elements it holds are about to go
		this.cardsByPath.clear();
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
			uniform: this.config.get('cardSize') === 'uniform',
			maxSpan,
		};
	}

	private renderCard(gridEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): void {
		const file = entry.file;
		const cardEl = gridEl.createDiv('bcc-card');
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
		if (cached === null) {
			card.coverEl.addClass('bcc-cover-loading');
			this.observer.observe(cardEl);
		} else {
			this.paint(card, cached);
		}
	}

	private initialSpan(file: TFile): number {
		if (this.params.uniform) return Math.min(this.params.maxSpan, SIZE_STEPS.m);
		return Math.min(this.params.maxSpan, SIZE_STEPS[stepFromFileSize(file.stat.size)]);
	}

	private setSpan(card: Card, span: number): void {
		card.span = span;
		card.el.style.gridRow = `span ${span}`;
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
			// Middle click and Cmd-click both open in a new tab.
			void this.app.workspace.openLinkText(file.path, '', Keymap.isModEvent(evt) || evt.button === 1);
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
			this.scheduleFit();
			return;
		}

		if (this.params.markdown) {
			this.contentObserver.observe(card.bodyEl);
			void MarkdownRenderer.render(this.app, excerpt, card.bodyEl, card.file.path, this).then(() =>
				this.scheduleFit(),
			);
			return;
		}

		card.bodyEl.setText(stripMarkdown(excerpt));
		this.scheduleFit();
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

		this.scheduleFit();
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
	private scheduleFit(): void {
		if (this.fitHandle !== 0) return;

		// The card's own window, so this still works when the view is in a popout.
		const win = this.rootEl.ownerDocument.defaultView;
		if (!win) return;

		this.fitHandle = win.requestAnimationFrame(() => {
			this.fitHandle = 0;
			this.fitAll();
		});
	}

	/** Read every height first, then write every span: interleaving the two forces a layout per card. */
	private fitAll(): void {
		const measurements: Measurement[] = [];
		let shown = 0;

		for (const card of this.cardsByPath.values()) {
			if (card.el.hasClass('bcc-card-hidden')) continue; // no layout to measure
			shown++;
			if (!card.filled) continue;
			measurements.push({ card, needed: card.bodyEl.offsetHeight, available: card.coverEl.clientHeight });
		}

		for (const measurement of measurements) this.fit(measurement);

		this.reconcileGroups();
		this.countEl.setText(this.matcher ? `${shown} of ${this.cardsByPath.size}` : '');
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

function defaultParams(): RenderParams {
	return {
		selector: { kind: 'body' },
		selectorProperty: null,
		maxLength: 300,
		markdown: false,
		uniform: false,
		maxSpan: SIZE_STEPS.l,
	};
}
