/**
 * Fills a development vault with synthetic notes and a matching .base.
 *
 * Deliberately synthetic rather than a copy of a real vault: the interesting
 * property here is the *spread* of note lengths, which is what the file-size
 * height estimate stands or falls on. A handful of empty notes are included on
 * purpose — an empty cover should look empty, not broken.
 *
 *   node scripts/seed-dev-vault.mjs [vaultPath] [count]
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const vault = process.argv[2] ?? path.join(homedir(), 'Git', 'obsidian-dev-vault');
const count = Number(process.argv[3] ?? 120);
const notesDir = path.join(vault, 'Notes');

const TAGS = ['reference', 'idea', 'project', 'reading', 'howto'];
const WORDS = `content cards bases obsidian vault note property formula view column cover
excerpt heading block selector layout grid masonry render markdown cache mtime lazy
observer height estimate span truncate frontmatter section paragraph`
	.split(/\s+/)
	.filter(Boolean);

function words(n) {
	return Array.from({ length: n }, (_, i) => WORDS[(i * 7 + n) % WORDS.length]).join(' ');
}

function paragraph(seed) {
	const text = words(18 + (seed % 40));
	return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/** Lengths are spread on purpose: empty, one-liner, medium, long. */
function bodyFor(index) {
	if (index % 17 === 0) return '';
	if (index % 11 === 0) return paragraph(index);

	const paragraphs = 1 + (index % 6);
	const parts = [];

	for (let i = 0; i < paragraphs; i++) {
		parts.push(paragraph(index + i * 3));
	}

	if (index % 4 === 0) {
		parts.push('## Fazit', paragraph(index + 99));
	}

	if (index % 9 === 0) {
		parts.push(`A sentence worth quoting. ^quote-${index}`);
	}

	return parts.join('\n\n');
}

function noteFor(index) {
	const tags = [TAGS[index % TAGS.length]];
	if (index % 5 === 0) tags.push(TAGS[(index + 2) % TAGS.length]);

	const created = new Date(Date.UTC(2026, 0, 1 + (index % 220))).toISOString().slice(0, 10);

	return [
		'---',
		`tags: [${tags.join(', ')}]`,
		`created: ${created}`,
		`cover: ${index % 8 === 0 ? '#Fazit' : ':'}`,
		'---',
		'',
		bodyFor(index),
		'',
	].join('\n');
}

const BASE = `filters:
  and:
    - file.folder == "Notes"
    - file.ext == "md"
views:
  - type: content-cards
    name: Cards
    order:
      - file.name
      - tags
      - created
    coverSelector: ":"
    maxLength: 300
    cardSize: auto
    maxSize: l
  - type: table
    name: Table
    order:
      - file.name
      - tags
      - created
`;

await rm(notesDir, { recursive: true, force: true });
await mkdir(notesDir, { recursive: true });

for (let index = 0; index < count; index++) {
	const name = `Note ${String(index + 1).padStart(3, '0')}.md`;
	await writeFile(path.join(notesDir, name), noteFor(index), 'utf8');
}

await writeFile(path.join(vault, 'Dev.base'), BASE, 'utf8');

console.log(`Wrote ${count} notes to ${notesDir} and a Dev.base alongside them.`);
