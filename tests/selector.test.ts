import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BlockCache, CachedMetadata, HeadingCache } from 'obsidian';

import { bodyStart, parseSelector, resolveSelector, stripMarkdown, truncate } from '../src/selector.ts';

/**
 * Minimal stand-ins for Obsidian's CachedMetadata — typed against the real thing,
 * so a change in the API breaks here rather than in the view. Full fixtures can be
 * lifted from the dev vault console:
 *   app.metadataCache.getFileCache(app.workspace.getActiveFile())
 */
function cache(parts: Partial<CachedMetadata>): CachedMetadata {
	return parts;
}

function span(startLine: number, endLine: number) {
	return {
		start: { line: startLine, col: 0, offset: 0 },
		end: { line: endLine, col: 0, offset: 0 },
	};
}

function heading(name: string, level: number, line: number): HeadingCache {
	return { heading: name, level, position: span(line, line) };
}

function block(id: string, startLine: number, endLine: number): BlockCache {
	return { id, position: span(startLine, endLine) };
}

describe('parseSelector', () => {
	test('empty and ":" both mean the whole body', () => {
		assert.deepEqual(parseSelector(''), { kind: 'body' });
		assert.deepEqual(parseSelector(':'), { kind: 'body' });
		assert.deepEqual(parseSelector(null), { kind: 'body' });
	});

	test('headings ignore leading hashes and surrounding space', () => {
		assert.deepEqual(parseSelector('#Fazit'), { kind: 'heading', name: 'Fazit' });
		assert.deepEqual(parseSelector('  ###  Fazit  '), { kind: 'heading', name: 'Fazit' });
	});

	test('block ids', () => {
		assert.deepEqual(parseSelector('^abc123'), { kind: 'block', id: 'abc123' });
	});

	test('line ranges, open at either end', () => {
		assert.deepEqual(parseSelector('12:20'), { kind: 'lines', from: 12, to: 20 });
		assert.deepEqual(parseSelector('12:'), { kind: 'lines', from: 12, to: null });
	});

	test('nonsense returns null so the caller can fall back', () => {
		assert.equal(parseSelector('#'), null);
		assert.equal(parseSelector('^'), null);
		assert.equal(parseSelector('20:12'), null, 'reversed range');
		assert.equal(parseSelector('0:5'), null, 'lines are 1-based');
		assert.equal(parseSelector('some text'), null);
	});
});

describe('resolveSelector — body', () => {
	const content = ['---', 'tags: [a]', '---', '', 'First line.', 'Second line.'].join('\n');

	test('skips frontmatter when the cache reports it', () => {
		const meta = cache({ frontmatterPosition: span(0, 2) });
		assert.equal(resolveSelector(content, meta, { kind: 'body' }), 'First line.\nSecond line.');
	});

	test('returns everything when there is no frontmatter', () => {
		assert.equal(resolveSelector('Just text.', null, { kind: 'body' }), 'Just text.');
	});

	test('bodyStart is 0 without frontmatter', () => {
		assert.equal(bodyStart(null), 0);
	});

	test('strips frontmatter from the text when the cache is cold', () => {
		// getFileCache() returns nothing for a file Obsidian has not indexed yet.
		assert.equal(resolveSelector(content, null, { kind: 'body' }), 'First line.\nSecond line.');
	});

	test('closing fence may be "..."', () => {
		const dotted = ['---', 'tags: [a]', '...', 'Body.'].join('\n');
		assert.equal(resolveSelector(dotted, null, { kind: 'body' }), 'Body.');
	});

	test('an unterminated fence is shown rather than swallowing the note', () => {
		const broken = ['---', 'not really frontmatter', 'still going'].join('\n');
		assert.equal(resolveSelector(broken, null, { kind: 'body' }), broken);
	});

	test('a leading horizontal rule is not mistaken for frontmatter', () => {
		assert.equal(resolveSelector('Intro.\n\n---\n\nMore.', null, { kind: 'body' }), 'Intro.\n\n---\n\nMore.');
	});
});

describe('resolveSelector — heading', () => {
	const content = [
		'# Title', // 0
		'Intro.', // 1
		'## Fazit', // 2
		'It works.', // 3
		'### Detail', // 4
		'Still part of Fazit.', // 5
		'## Anhang', // 6
		'Not part of Fazit.', // 7
	].join('\n');

	const meta = cache({
		headings: [
			heading('Title', 1, 0),
			heading('Fazit', 2, 2),
			heading('Detail', 3, 4),
			heading('Anhang', 2, 6),
		],
	});

	test('runs until the next heading of the same rank, keeping subheadings', () => {
		assert.equal(
			resolveSelector(content, meta, { kind: 'heading', name: 'Fazit' }),
			'It works.\n### Detail\nStill part of Fazit.',
		);
	});

	test('matches case-insensitively', () => {
		assert.equal(resolveSelector(content, meta, { kind: 'heading', name: 'fazit' }), resolveSelector(content, meta, { kind: 'heading', name: 'Fazit' }));
	});

	test('runs to the end of the file for the last heading', () => {
		assert.equal(resolveSelector(content, meta, { kind: 'heading', name: 'Anhang' }), 'Not part of Fazit.');
	});

	test('unknown heading yields an empty cover rather than the whole note', () => {
		assert.equal(resolveSelector(content, meta, { kind: 'heading', name: 'Nope' }), '');
		assert.equal(resolveSelector(content, null, { kind: 'heading', name: 'Fazit' }), '');
	});
});

describe('resolveSelector — block', () => {
	const content = ['Intro.', 'The important sentence. ^abc123', 'Outro.'].join('\n');
	const meta = cache({ blocks: { abc123: block('abc123', 1, 1) } });

	test('returns the block without its id', () => {
		assert.equal(resolveSelector(content, meta, { kind: 'block', id: 'abc123' }), 'The important sentence.');
	});

	test('unknown block yields empty', () => {
		assert.equal(resolveSelector(content, meta, { kind: 'block', id: 'missing' }), '');
	});
});

describe('resolveSelector — lines', () => {
	const content = ['one', 'two', 'three', 'four'].join('\n');

	test('1-based and inclusive on both ends', () => {
		assert.equal(resolveSelector(content, null, { kind: 'lines', from: 2, to: 3 }), 'two\nthree');
	});

	test('open ends run to the start or the end of the file', () => {
		assert.equal(resolveSelector(content, null, { kind: 'lines', from: 3, to: null }), 'three\nfour');
		assert.equal(resolveSelector(content, null, { kind: 'lines', from: null, to: 2 }), 'one\ntwo');
	});

	test('ranges past the end are clamped, not an error', () => {
		assert.equal(resolveSelector(content, null, { kind: 'lines', from: 3, to: 99 }), 'three\nfour');
		assert.equal(resolveSelector(content, null, { kind: 'lines', from: 90, to: 99 }), '');
	});
});

describe('truncate', () => {
	test('leaves short text alone', () => {
		assert.equal(truncate('short', 100), 'short');
	});

	test('cuts at a word boundary when one is near', () => {
		assert.equal(truncate('alpha beta gamma delta', 16), 'alpha beta…');
	});

	test('cuts hard when the word is longer than the budget', () => {
		assert.equal(truncate('aaaaaaaaaaaaaaaaaaaa', 5), 'aaaaa…');
	});

	test('drops an embed the cut ran through', () => {
		assert.equal(truncate('Intro text ![[Pasted image 20260810.png]]', 22), 'Intro text…');
		assert.equal(truncate('Intro text [[Some Note]]', 18), 'Intro text…');
		assert.equal(truncate('Intro text ![alt](https://example.com/a.png)', 26), 'Intro text…');
		assert.equal(truncate('Intro text [label](https://example.com)', 26), 'Intro text…');
	});

	test('keeps links the cut did not reach into', () => {
		assert.equal(truncate('See [[Some Note]] and then more words', 22), 'See [[Some Note]] and…');
		assert.equal(truncate('See ![[a.png]] and then more words', 22), 'See ![[a.png]] and…');
	});

	test('leaves bracketed text that is not a link alone', () => {
		assert.equal(truncate('- [ ] a task that runs on and on', 14), '- [ ] a task…');
		assert.equal(truncate('Status [draft] and more words here', 20), 'Status [draft] and…');
	});

	test('an excerpt that was nothing but a cut embed comes back empty', () => {
		assert.equal(truncate('![[Pasted image 20260810.png]]', 12), '');
	});
});

describe('stripMarkdown', () => {
	test('unwraps links and drops markers', () => {
		assert.equal(stripMarkdown('## Heading'), 'Heading');
		assert.equal(stripMarkdown('see [[Note|the note]]'), 'see the note');
		assert.equal(stripMarkdown('see [[Note]]'), 'see Note');
		assert.equal(stripMarkdown('see [text](https://example.com)'), 'see text');
		assert.equal(stripMarkdown('**bold** and *italic*'), 'bold and italic');
		assert.equal(stripMarkdown('- [ ] a task'), 'a task');
	});

	test('removes embeds entirely', () => {
		assert.equal(stripMarkdown('![[image.png]]\nCaption.'), 'Caption.');
	});
});
