import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { excerptAround, type Excerpt } from '../src/search.ts';

describe('excerptAround', () => {
	/** What the reader actually sees highlighted. If this is right, the offsets are right. */
	function highlighted(excerpt: Excerpt): string[] {
		return excerpt.matches.map(([from, to]) => excerpt.text.slice(from, to));
	}

	const long = `Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega and then the NEEDLE sits here far past any excerpt boundary followed by yet more filler words to run past the end`;
	const needle = long.indexOf('NEEDLE');

	test('leaves text that fits alone', () => {
		const excerpt = excerptAround('Short enough', [[6, 12]], 100);
		assert.equal(excerpt.text, 'Short enough');
		assert.deepEqual(highlighted(excerpt), ['enough']);
	});

	test('stays at the top when the hit is already inside the plain excerpt', () => {
		const excerpt = excerptAround(long, [[6, 10]], 60);
		assert.ok(!excerpt.text.startsWith('…'), 'window should not have moved');
		assert.deepEqual(highlighted(excerpt), ['beta']);
	});

	test('travels to a hit that sits past the excerpt, and marks both cuts', () => {
		const excerpt = excerptAround(long, [[needle, needle + 6]], 60);
		assert.ok(excerpt.text.startsWith('…'), 'should show it cut from the left');
		assert.ok(excerpt.text.endsWith('…'), 'should show it cut from the right');
		assert.deepEqual(highlighted(excerpt), ['NEEDLE']);
		assert.ok(excerpt.text.length <= 62, `window ran long: ${excerpt.text.length}`);
	});

	test('builds the window around the earliest hit whatever order they arrive in', () => {
		const excerpt = excerptAround(long, [
			[needle, needle + 6],
			[6, 10],
		], 60);
		assert.ok(!excerpt.text.startsWith('…'), 'earliest hit is at the top, so the window stays');
		assert.ok(highlighted(excerpt).includes('beta'));
	});

	test('clips a hit that runs past the window instead of dropping it', () => {
		const excerpt = excerptAround(long, [[needle, needle + 60]], 40);
		const shown = highlighted(excerpt);

		assert.equal(shown.length, 1);
		assert.ok(shown[0]!.startsWith('NEEDLE'), shown[0]);
		assert.ok(shown[0]!.length < 60, 'should have been cut down to the window');
	});

	test('survives having no hits at all', () => {
		const excerpt = excerptAround(long, [], 60);
		assert.deepEqual(excerpt.matches, []);
		assert.ok(!excerpt.text.startsWith('…'));
		assert.ok(excerpt.text.endsWith('…'));
	});
});
