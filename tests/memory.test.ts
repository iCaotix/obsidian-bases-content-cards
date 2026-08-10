import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { WorkspaceLeaf } from 'obsidian';

import { basePathOf, memoryFor, nowhere } from '../src/memory.ts';

/** A leaf is only ever used here as a WeakMap key and for its view state. */
function leafShowing(file?: unknown): WorkspaceLeaf {
	return { getViewState: () => ({ state: file === undefined ? {} : { file } }) } as unknown as WorkspaceLeaf;
}

describe('basePathOf', () => {
	test('a tab showing a base', () => {
		assert.equal(basePathOf(leafShowing('Notes/Reading.base')), 'Notes/Reading.base');
	});

	test('a view with no tab of its own has no place to remember', () => {
		assert.equal(basePathOf(null), null);
	});

	test('an embedded base is keyed on nothing, not on its note', () => {
		assert.equal(basePathOf(leafShowing('Notes/Journal.md')), null);
		assert.equal(basePathOf(leafShowing()), null);
		assert.equal(basePathOf(leafShowing(42)), null);
	});
});

describe('memoryFor', () => {
	test('the same tab on the same view gets the same memory back', () => {
		const leaf = leafShowing('Reading.base');
		const first = memoryFor(leaf, 'Reading.base', 'Cards');

		first.query = 'kant';
		assert.equal(memoryFor(leaf, 'Reading.base', 'Cards'), first);
		assert.equal(memoryFor(leaf, 'Reading.base', 'Cards').query, 'kant');
	});

	test('navigating to another base starts over', () => {
		const leaf = leafShowing('Reading.base');
		memoryFor(leaf, 'Reading.base', 'Cards').query = 'kant';

		assert.equal(memoryFor(leaf, 'Projects.base', 'Cards').query, '');
	});

	test('another view of the same base starts over too', () => {
		const leaf = leafShowing('Reading.base');
		memoryFor(leaf, 'Reading.base', 'Cards').query = 'kant';

		assert.equal(memoryFor(leaf, 'Reading.base', 'Wide cards').query, '');
	});

	test('two tabs on one base keep their own place', () => {
		const one = memoryFor(leafShowing('Reading.base'), 'Reading.base', 'Cards');
		const two = memoryFor(leafShowing('Reading.base'), 'Reading.base', 'Cards');

		one.place = { path: 'A.md', offset: 12, top: 900 };

		assert.notEqual(one, two);
		assert.equal(two.place.path, null);
	});

	test('the two places are separate, so a search cannot overwrite the base underneath it', () => {
		const store = memoryFor(leafShowing('Reading.base'), 'Reading.base', 'Cards');

		store.queryPlace.path = 'Result.md';

		assert.equal(store.place.path, null);
	});
});

describe('nowhere', () => {
	test('is the top of the grid, and a fresh object every time', () => {
		assert.deepEqual(nowhere(), { path: null, offset: 0, top: 0 });
		assert.notEqual(nowhere(), nowhere());
	});
});
