import {
	Keymap,
	parsePropertyId,
	type App,
	type BasesEntry,
	type BasesPropertyId,
	type Component,
	type HoverParent,
	type PaneType,
	type TFile,
} from 'obsidian';

import { hueFor } from './tint.ts';

export interface Card {
	el: HTMLElement;
	/** The window: sized by the card, so its height is the space on offer. */
	coverEl: HTMLElement;
	/** The text: sized by itself, so its height is the space required. */
	bodyEl: HTMLElement;
	titleEl: HTMLElement;
	file: TFile;
	/**
	 * Owns whatever the markdown renderer built into this cover — image embeds,
	 * transclusions, and the listeners they come with. A cover is re-rendered on
	 * every change to its note and at the end of every search, and each of those
	 * would otherwise leave its predecessor loaded and listening on detached DOM.
	 */
	renderer: Component | null;
	span: number;
	filled: boolean;
	/**
	 * The cover's text with the markdown taken out, so that a keystroke costs one
	 * search over a string rather than re-reading and re-stripping the note. Null
	 * until the content arrives.
	 */
	haystack: string | null;
}

/** What building a card needs from the view around it. */
export interface CardHost {
	app: App;
	hoverParent: HoverParent;
	displayNameOf: (propertyId: BasesPropertyId) => string;
	openInNewTab: () => boolean;
}

/** Builds a card's DOM. The caller owns its span, its content and its observers. */
export function createCard(host: CardHost, gridEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): Card {
	const file = entry.file;
	const cardEl = gridEl.createDiv('bcc-card');
	// Set whether or not tinting is on: it costs a string, and the stylesheet is
	// then the only thing that has to know what "off" looks like.
	cardEl.style.setProperty('--bcc-hue', String(hueFor(file.path)));

	const coverEl = cardEl.createDiv('bcc-cover');
	const bodyEl = coverEl.createDiv('bcc-cover-body');
	const titleEl = renderFooter(host, cardEl, entry, order);

	makeOpenable(host, cardEl, file);

	return { el: cardEl, coverEl, bodyEl, titleEl, file, span: 0, filled: false, haystack: null, renderer: null };
}

/** Returns the title element, which a search has to be able to highlight. */
function renderFooter(host: CardHost, cardEl: HTMLElement, entry: BasesEntry, order: BasesPropertyId[]): HTMLElement {
	const footerEl = cardEl.createDiv('bcc-footer');

	const titleEl = footerEl.createEl('a', { cls: 'bcc-title', text: entry.file.basename });
	titleEl.addEventListener('mouseover', (evt) => {
		host.app.workspace.trigger('hover-link', {
			event: evt,
			source: 'bases',
			hoverParent: host.hoverParent,
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
			el.createSpan({ cls: 'bcc-prop-label', text: host.displayNameOf(propertyId) });
			el.createSpan({ cls: 'bcc-prop-value', text: value.toString() });
		});
	}

	return titleEl;
}

/**
 * The whole card opens its note — cover, title and properties alike. Two things
 * must still get through: links inside a markdown-rendered cover belong to
 * Obsidian, and a click that ends a text selection is not a click on the card.
 */
function makeOpenable(host: CardHost, cardEl: HTMLElement, file: TFile): void {
	const open = (evt: MouseEvent) => {
		if (evt.button !== 0 && evt.button !== 1) return;

		const link = (evt.target as HTMLElement).closest('a');
		if (link && !link.hasClass('bcc-title')) return;

		const selection = cardEl.ownerDocument.defaultView?.getSelection();
		if (selection && !selection.isCollapsed && cardEl.contains(selection.anchorNode)) return;

		evt.preventDefault();

		// The modifier decides when there is one — it can also ask for a split, which
		// the option has no way to express. Failing that, a middle click or the option
		// opens a tab.
		let target: PaneType | boolean = Keymap.isModEvent(evt);
		if (target === false && (evt.button === 1 || host.openInNewTab())) target = 'tab';

		void host.app.workspace.openLinkText(file.path, '', target);
	};

	cardEl.addEventListener('click', open);
	cardEl.addEventListener('auxclick', open); // middle click does not fire 'click'
}
