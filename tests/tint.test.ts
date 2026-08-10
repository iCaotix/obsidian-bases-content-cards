import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hueFor } from '../src/tint.ts';

describe('hueFor', () => {
	test('the same note always gets the same hue', () => {
		assert.equal(hueFor('Notes/Kant.md'), hueFor('Notes/Kant.md'));
	});

	test('the hue is one of twelve, on the circle', () => {
		for (const path of ['a', 'Notes/Kant.md', 'x'.repeat(300), '', 'Ünïcödé 🎴.md']) {
			const hue = hueFor(path);
			assert.ok(hue >= 0 && hue < 360, `${path}: ${hue}`);
			assert.equal(hue % 30, 0, `${path}: ${hue}`);
		}
	});

	test('a folder of sequential notes does not come out two colours', () => {
		const hues = new Set<number>();
		for (let index = 1; index <= 60; index++) hues.add(hueFor(`Inbox/note ${index}.md`));

		assert.ok(hues.size >= 10, `sequential paths collapsed onto ${hues.size} hues`);
	});

	test('a moved note is a different note — the colour follows the path', () => {
		assert.notEqual(hueFor('Inbox/Kant.md'), hueFor('Archive/Kant.md'));
	});
});
