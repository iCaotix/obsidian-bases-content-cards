import type { CachedMetadata } from 'obsidian';

/**
 * Which part of a note a cover shows.
 *
 * Deliberately small: `body` and `heading` cover almost every real use, `block`
 * exists because Obsidian already has stable block addresses, and `lines` is the
 * escape hatch. Line numbers shift silently when a note is edited above them, so
 * they are documented as a last resort rather than a feature.
 */
export type Selector =
	| { kind: 'body' }
	| { kind: 'heading'; name: string }
	| { kind: 'block'; id: string }
	| { kind: 'lines'; from: number | null; to: number | null };

const LINE_RANGE = /^(\d*):(\d*)$/;

/** Returns null for input that is not a valid selector, so callers can fall back. */
export function parseSelector(raw: string | null | undefined): Selector | null {
	const value = (raw ?? '').trim();

	if (value === '' || value === ':') return { kind: 'body' };

	if (value.startsWith('#')) {
		const name = value.replace(/^#+/, '').trim();
		return name === '' ? null : { kind: 'heading', name };
	}

	if (value.startsWith('^')) {
		const id = value.slice(1).trim();
		return id === '' ? null : { kind: 'block', id };
	}

	const range = LINE_RANGE.exec(value);
	if (range) {
		const from = range[1] ? Number(range[1]) : null;
		const to = range[2] ? Number(range[2]) : null;
		if (from !== null && from < 1) return null;
		if (to !== null && to < 1) return null;
		if (from !== null && to !== null && to < from) return null;
		return { kind: 'lines', from, to };
	}

	return null;
}

/**
 * Cuts the addressed part out of a note. Line numbers are 1-based and count from
 * the top of the file, frontmatter included — that matches what the editor shows.
 */
export function resolveSelector(content: string, cache: CachedMetadata | null, selector: Selector): string {
	const lines = content.split('\n');

	switch (selector.kind) {
		case 'body':
			return join(lines, bodyStart(cache, lines), lines.length - 1);
		case 'heading':
			return resolveHeading(lines, cache, selector.name);
		case 'block':
			return resolveBlock(lines, cache, selector.id);
		case 'lines': {
			const from = (selector.from ?? 1) - 1;
			const to = (selector.to ?? lines.length) - 1;
			return join(lines, from, to);
		}
	}
}

/**
 * First line after the frontmatter block, or 0 when there is none.
 *
 * The metadata cache is the good answer, but it is not always there: a card can
 * be painted before Obsidian has indexed that file, and then `getFileCache()`
 * reports nothing at all. Falling back to the text itself keeps frontmatter out
 * of the cover either way.
 */
export function bodyStart(cache: CachedMetadata | null, lines: string[] = []): number {
	const position = cache?.frontmatterPosition;
	if (position) return position.end.line + 1;
	return frontmatterEnd(lines);
}

function frontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== '---') return 0;

	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (line === '---' || line === '...') return index + 1;
	}

	// Unterminated: not frontmatter after all, so show it rather than swallow the note.
	return 0;
}

function resolveHeading(lines: string[], cache: CachedMetadata | null, name: string): string {
	const headings = cache?.headings ?? [];
	const wanted = name.toLowerCase();

	const index = headings.findIndex((heading) => heading.heading.trim().toLowerCase() === wanted);
	if (index === -1) return '';

	const start = headings[index]!;
	// The section ends at the next heading of the same or higher rank — a deeper
	// subheading still belongs to it.
	const next = headings.slice(index + 1).find((heading) => heading.level <= start.level);

	return join(lines, start.position.start.line + 1, (next?.position.start.line ?? lines.length) - 1);
}

function resolveBlock(lines: string[], cache: CachedMetadata | null, id: string): string {
	const block = cache?.blocks?.[id];
	if (!block) return '';

	const text = join(lines, block.position.start.line, block.position.end.line);
	// Drop the trailing block id, it is plumbing rather than content.
	return text.replace(new RegExp(`\\s*\\^${escapeRegex(id)}\\s*$`), '');
}

function join(lines: string[], start: number, end: number): string {
	const from = Math.max(0, start);
	const to = Math.min(lines.length - 1, end);
	if (from > to) return '';
	return lines.slice(from, to + 1).join('\n').trim();
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cuts at a word boundary when one is close enough, so covers do not end mid-word. */
export function truncate(text: string, maxLength: number): string {
	if (maxLength <= 0 || text.length <= maxLength) return text;

	const cut = text.slice(0, maxLength);
	const lastSpace = cut.lastIndexOf(' ');
	const kept = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;

	return kept.trimEnd() + '…';
}

/**
 * Enough markdown removal to make a plain-text cover readable. Not a parser, and
 * not meant to be one — when fidelity matters, the view renders real markdown.
 */
export function stripMarkdown(text: string): string {
	return text
		.replace(/^```[\s\S]*?^```$/gm, '')            // fenced code blocks
		.replace(/!\[\[[^\]]*\]\]/g, '')               // embeds
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // aliased wikilinks
		.replace(/\[\[([^\]]+)\]\]/g, '$1')            // plain wikilinks
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // markdown links
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')            // heading markers
		.replace(/^\s{0,3}>\s?/gm, '')                 // blockquotes
		.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')     // task markers
		.replace(/^\s*[-*+]\s+/gm, '')                 // list bullets
		.replace(/(\*\*|__)(.*?)\1/g, '$2')            // bold
		.replace(/(\*|_)(.*?)\1/g, '$2')               // italics
		.replace(/`([^`]*)`/g, '$1')                   // inline code
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
