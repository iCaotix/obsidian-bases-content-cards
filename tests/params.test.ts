import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BasesViewConfig } from 'obsidian';

import { ROW_HEIGHT, SIZE_STEPS, clampSpan, defaultParams, nextSpan, readParams, stepFromFileSize } from '../src/params.ts';

/**
 * Bases hands the view a config object; only the two accessors matter here.
 * `get()` returns `unknown`, which is the whole reason `readParams` exists.
 */
function config(values: Record<string, unknown>): BasesViewConfig {
	return {
		get: (key: string) => values[key],
		getAsPropertyId: () => null,
	} as unknown as BasesViewConfig;
}

describe('readParams', () => {
	test('an empty config gives the same answer as the defaults', () => {
		assert.deepEqual(readParams(config({})), defaultParams());
	});

	test('reads the options through', () => {
		const params = readParams(
			config({
				coverSelector: '#Fazit',
				maxLength: 500,
				renderMarkdown: true,
				wrapTitle: true,
				openInNewTab: true,
				cardTint: 'strong',
				cardSize: 'uniform',
				maxSize: 's',
			}),
		);

		assert.deepEqual(params.selector, { kind: 'heading', name: 'Fazit' });
		assert.equal(params.maxLength, 500);
		assert.equal(params.markdown, true);
		assert.equal(params.wrapTitle, true);
		assert.equal(params.newTab, true);
		assert.equal(params.tint, 'strong');
		assert.equal(params.uniform, true);
		assert.equal(params.maxSpan, SIZE_STEPS.s);
	});

	test('"unlimited" lets a card grow to whatever its cover needs', () => {
		assert.equal(readParams(config({ maxSize: 'unlimited' })).maxSpan, Number.POSITIVE_INFINITY);
	});

	test('a cover selector that means nothing falls back to the body', () => {
		assert.deepEqual(readParams(config({ coverSelector: 'nonsense' })).selector, { kind: 'body' });
	});

	test('wrong-typed values fall back rather than reaching the layout', () => {
		const params = readParams(config({ maxLength: 'lots', maxSize: 'gigantic', cardTint: 'neon', renderMarkdown: 'yes' }));

		assert.equal(params.maxLength, 300);
		assert.equal(params.maxSpan, SIZE_STEPS.l);
		assert.equal(params.tint, 'off');
		assert.equal(params.markdown, false, 'only a real boolean turns a toggle on');
	});
});

describe('stepFromFileSize', () => {
	test('grades bytes into the four steps', () => {
		assert.equal(stepFromFileSize(0), 's');
		assert.equal(stepFromFileSize(599), 's');
		assert.equal(stepFromFileSize(600), 'm');
		assert.equal(stepFromFileSize(1799), 'm');
		assert.equal(stepFromFileSize(1800), 'l');
		assert.equal(stepFromFileSize(4499), 'l');
		assert.equal(stepFromFileSize(4500), 'xl');
		assert.equal(stepFromFileSize(9_000_000), 'xl');
	});

	test('every step names a real height, in order', () => {
		const steps = [SIZE_STEPS.s, SIZE_STEPS.m, SIZE_STEPS.l, SIZE_STEPS.xl];
		assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
	});
});

describe('clampSpan', () => {
	test('no card is shorter than the smallest step or taller than the setting', () => {
		assert.equal(clampSpan(1, SIZE_STEPS.l), SIZE_STEPS.s);
		assert.equal(clampSpan(999, SIZE_STEPS.l), SIZE_STEPS.l);
		assert.equal(clampSpan(SIZE_STEPS.m, SIZE_STEPS.l), SIZE_STEPS.m);
	});

	test('an unlimited maximum caps nothing', () => {
		assert.equal(clampSpan(500, Number.POSITIVE_INFINITY), 500);
	});
});

describe('nextSpan', () => {
	const max = Number.POSITIVE_INFINITY;

	test('a cover that fits keeps its span', () => {
		assert.equal(nextSpan(SIZE_STEPS.m, 100, 100, max), SIZE_STEPS.m);
	});

	test('grants whole rows, rounding up: missing text is worse than slack', () => {
		assert.equal(nextSpan(SIZE_STEPS.m, 100 + ROW_HEIGHT, 100, max), SIZE_STEPS.m + 1);
		assert.equal(nextSpan(SIZE_STEPS.m, 101, 100, max), SIZE_STEPS.m + 1, 'one pixel over still costs a row');
	});

	test('shrinks a card as readily as it grows one', () => {
		assert.equal(nextSpan(SIZE_STEPS.l, 100 - 3 * ROW_HEIGHT, 100, max), SIZE_STEPS.l - 3);
	});

	test('is absolute, so repeating it at the same measurements settles', () => {
		const once = nextSpan(SIZE_STEPS.m, 400, 240, max);
		assert.equal(nextSpan(once, 400, 400, max), once);
	});

	test('stays within the setting in both directions', () => {
		assert.equal(nextSpan(SIZE_STEPS.l, 5000, 100, SIZE_STEPS.l), SIZE_STEPS.l);
		assert.equal(nextSpan(SIZE_STEPS.s, 0, 5000, SIZE_STEPS.l), SIZE_STEPS.s);
	});
});
