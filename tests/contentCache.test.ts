import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { App, TFile } from 'obsidian';

import { ContentCache } from '../src/contentCache.ts';

/** Counts reads, so "idempotent" and "cached" can be told apart from "worked". */
function vault(contents: Record<string, string | Error>) {
	const reads: string[] = [];

	const app = {
		vault: {
			cachedRead: (file: TFile) => {
				reads.push(file.path);
				const content = contents[file.path];
				return content instanceof Error ? Promise.reject(content) : Promise.resolve(content ?? '');
			},
		},
	} as unknown as App;

	return { app, reads };
}

function note(path: string, mtime = 1): TFile {
	return { path, stat: { mtime, size: 100 } } as TFile;
}

/** Lets the read's promise chain run to its end. */
function settled(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe('ContentCache', () => {
	test('a lookup misses until the read comes back, then the view is told', async () => {
		const { app } = vault({ 'A.md': 'Alpha' });
		const loaded: string[] = [];
		const cache = new ContentCache(app, (path) => loaded.push(path));
		const file = note('A.md');

		assert.equal(cache.get(file), null);

		cache.request(file);
		assert.equal(cache.get(file), null, 'reading is not synchronous');

		await settled();

		assert.equal(cache.get(file), 'Alpha');
		assert.deepEqual(loaded, ['A.md']);
	});

	test('an edited note is a miss, so a stale cover cannot be shown', async () => {
		const { app } = vault({ 'A.md': 'Alpha' });
		const cache = new ContentCache(app, () => {});

		cache.request(note('A.md', 1));
		await settled();

		assert.equal(cache.get(note('A.md', 1)), 'Alpha');
		assert.equal(cache.get(note('A.md', 2)), null, 'the copy is older than the file');
	});

	test('asking twice reads once, whether it is in flight or already here', async () => {
		const { app, reads } = vault({ 'A.md': 'Alpha' });
		const cache = new ContentCache(app, () => {});
		const file = note('A.md');

		cache.request(file);
		cache.request(file);
		await settled();
		cache.request(file);
		await settled();

		assert.deepEqual(reads, ['A.md']);
	});

	test('a read that failed does not wedge the path shut', async () => {
		const { app, reads } = vault({ 'A.md': new Error('gone') });
		const cache = new ContentCache(app, () => {});
		const file = note('A.md');

		cache.request(file);
		await settled();

		assert.equal(cache.get(file), null);

		cache.request(file);
		await settled();

		assert.deepEqual(reads, ['A.md', 'A.md'], 'the second attempt was allowed through');
	});

	test('invalidate drops one note, clear drops the lot', async () => {
		const { app } = vault({ 'A.md': 'Alpha', 'B.md': 'Beta' });
		const cache = new ContentCache(app, () => {});

		cache.request(note('A.md'));
		cache.request(note('B.md'));
		await settled();

		cache.invalidate('A.md');
		assert.equal(cache.get(note('A.md')), null);
		assert.equal(cache.get(note('B.md')), 'Beta');

		cache.clear();
		assert.equal(cache.get(note('B.md')), null);
	});

	test('a note re-read after invalidation comes back with what it says now', async () => {
		const contents: Record<string, string> = { 'A.md': 'Alpha' };
		const { app } = vault(contents);
		const cache = new ContentCache(app, () => {});
		const file = note('A.md');

		cache.request(file);
		await settled();

		contents['A.md'] = 'Alpha, edited';
		cache.invalidate('A.md');
		cache.request(file);
		await settled();

		assert.equal(cache.get(file), 'Alpha, edited');
	});
});
