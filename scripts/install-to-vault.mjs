/**
 * Installs the built plugin into a vault, the way a release would.
 *
 * This is the route into a *real* vault. A symlink is for the dev vault only:
 * it makes the production vault track whatever half-finished build happens to
 * be on disk, and this one auto-commits through obsidian-git. Copying pins it
 * to a build you deliberately made.
 *
 *   npm run build
 *   node scripts/install-to-vault.mjs "$HOME/Git/Obsidian Vault"
 */

import { access, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];

const repo = path.resolve(import.meta.dirname, '..');
const vault = process.argv[2];

function fail(message) {
	console.error(`${message}\n`);
	process.exit(1);
}

async function exists(target) {
	return access(target).then(
		() => true,
		() => false,
	);
}

if (!vault) fail('Usage: node scripts/install-to-vault.mjs <vault path>');

// A path that is not a vault would silently create a plugins folder Obsidian
// never looks at, and the mistake would only show up as "the plugin is missing".
if (!(await exists(path.join(vault, '.obsidian')))) {
	fail(`Not a vault (no .obsidian folder): ${vault}`);
}

if (!(await exists(path.join(repo, 'main.js')))) {
	fail('main.js is missing — run `npm run build` first.');
}

const { id, version } = JSON.parse(await readFile(path.join(repo, 'manifest.json'), 'utf8'));
const target = path.join(vault, '.obsidian', 'plugins', id);

// A symlink here means the vault is wired straight to the repo — the dev-vault
// setup. Copying through it would write the build artifacts back into the repo.
const linked = await lstat(target).then(
	(stats) => stats.isSymbolicLink(),
	() => false,
);
if (linked) {
	fail(`${target} is a symlink — that is the dev-vault setup. Remove it first, or pick another vault.`);
}

await mkdir(target, { recursive: true });
for (const file of ARTIFACTS) {
	await copyFile(path.join(repo, file), path.join(target, file));
}

console.log(`Installed ${id} ${version} to ${target}`);
console.log('Enable it under Settings → Community plugins (or use "Reload app without saving" to pick up a rebuild).');
