import {
	BasesEntry,
	BasesView,
	Keymap,
	MarkdownRenderer,
	parsePropertyId,
	type BasesPropertyId,
	type HoverParent,
	type HoverPopover,
	type QueryController,
	type TFile,
} from 'obsidian';

import { ContentCache } from './contentCache';
import { parseSelector, resolveSelector, stripMarkdown, truncate, type Selector } from './selector';

export const CONTENT_CARDS_VIEW = 'content-cards';

/** Grid row height in px. Must match --bcc-row-height in styles.css. */
const ROW_HEIGHT = 8;

/** Card heights in grid rows. */
const SIZE_STEPS = { s: 20, m: 30, l: 42, xl: 56 } as const;
export type SizeName = keyof typeof SIZE_STEPS;

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
	coverEl: HTMLElement;
	file: TFile;
	span: number;
	filled: boolean;
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
	private readonly cache: ContentCache;
	private readonly observer: IntersectionObserver;
	private readonly cardsByPath = new Map<string, Card>();
	private readonly cardsByEl = new WeakMap<Element, Card>();
	private params: RenderParams = defaultParams();

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);

		this.rootEl = parentEl.createDiv('bcc-container');
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
	}

	override onunload(): void {
		this.observer.disconnect();
		this.cache.clear();
		super.onunload();
	}

	public onDataUpdated(): void {
		this.params = this.readParams();
		this.observer.disconnect();
		this.cardsByPath.clear();
		this.rootEl.empty();

		const order = this.config.getOrder();

		for (const group of this.data.groupedData) {
			if (group.hasKey()) {
				this.rootEl.createDiv('bcc-group-title', (el) => el.setText(group.key?.toString() ?? ''));
			}

			const gridEl = this.rootEl.createDiv('bcc-grid');
			for (const entry of group.entries) {
				this.renderCard(gridEl, entry, order);
			}
		}
	}

	private readParams(): RenderParams {
		const maxSize = asString(this.config.get('maxSize'), 'l');

		return {
			selector: parseSelector(asString(this.config.get('coverSelector'), ':')) ?? { kind: 'body' },
			selectorProperty: this.config.getAsPropertyId('selectorProperty'),
			maxLength: asNumber(this.config.get('maxLength'), 300),
			markdown: this.config.get('renderMarkdown') === true,
			uniform: this.config.get('cardSize') === 'uniform',
			maxSpan: isSizeName(maxSize) ? SIZE_STEPS[maxSize] : SIZE_STEPS.l,
		};
	}

	private renderCard(gridEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): void {
		const file = entry.file;
		const cardEl = gridEl.createDiv('bcc-card');

		const card: Card = {
			el: cardEl,
			coverEl: cardEl.createDiv('bcc-cover'),
			file,
			span: SIZE_STEPS.m,
			filled: false,
		};

		this.setSpan(card, this.initialSpan(file));
		this.renderFooter(cardEl, entry, order);

		this.cardsByPath.set(file.path, card);
		this.cardsByEl.set(cardEl, card);

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

	private renderFooter(cardEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): void {
		const footerEl = cardEl.createDiv('bcc-footer');

		const titleEl = footerEl.createEl('a', { cls: 'bcc-title', text: entry.file.basename });
		titleEl.onClickEvent((evt: MouseEvent) => {
			if (evt.button !== 0 && evt.button !== 1) return;
			evt.preventDefault();
			void this.app.workspace.openLinkText(entry.file.path, '', Keymap.isModEvent(evt));
		});
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
		const { selector, maxLength, markdown } = this.params;

		const cache = this.app.metadataCache.getFileCache(card.file);
		const excerpt = truncate(resolveSelector(content, cache, this.selectorFor(card, selector)), maxLength);

		card.coverEl.empty();
		card.coverEl.removeClass('bcc-cover-loading');
		card.filled = true;

		if (excerpt === '') {
			card.coverEl.addClass('bcc-cover-empty');
			this.adjustSpan(card);
			return;
		}

		card.coverEl.removeClass('bcc-cover-empty');

		if (markdown) {
			void MarkdownRenderer.render(this.app, excerpt, card.coverEl, card.file.path, this).then(() =>
				this.adjustSpan(card),
			);
			return;
		}

		card.coverEl.setText(stripMarkdown(excerpt));
		this.adjustSpan(card);
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
	 * The one correction pass. The file-size guess is close but not exact — this
	 * trims the leftover, once per card, instead of letting every load reflow the
	 * grid. Differences under two rows are left alone; they are not worth a jump.
	 */
	private adjustSpan(card: Card): void {
		if (this.params.uniform) return;

		const overflowRows = Math.round((card.coverEl.scrollHeight - card.coverEl.clientHeight) / ROW_HEIGHT);
		if (Math.abs(overflowRows) < 2) return;

		const next = Math.min(this.params.maxSpan, Math.max(SIZE_STEPS.s, card.span + overflowRows));
		if (next !== card.span) this.setSpan(card, next);
	}
}

/** View options come back as `unknown`; a missing or wrong-typed value falls back. */
function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value !== '' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isSizeName(value: string): value is SizeName {
	return value in SIZE_STEPS;
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
