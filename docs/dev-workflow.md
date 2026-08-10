# Dev workflow for the plugin

Applies to `bases-content-cards`. Plan: [plan-content-cards.md](plan-content-cards.md),
API facts: [bases-api.md](bases-api.md).

Available locally: Node v24.18.1, npm 11.16.0, Obsidian 1.13.4. The npm package `obsidian`
sits at 1.13.1 — the Bases types (`@since 1.10.0`) are included in it.

## Ground rule: a separate dev vault

The documentation is unusually blunt on this point:

> "one mistake can lead to unintended changes to your vault. To prevent data loss, you
> should never develop plugins in your main vault."

Here that goes double: `Obsidian Vault` hangs off obsidian-git with auto-commit. A plugin that
touches files while being tested writes that into the history unasked.

So: a second vault, e.g. `~/Git/obsidian-dev-vault/`.

## Layout

```
~/Git/obsidian-bases-content-cards/        ← the git repo
├── src/
│   ├── main.ts            registration, settings
│   ├── view.ts            the BasesView
│   ├── selector.ts        pure functions, no Obsidian import
│   └── contentCache.ts    cachedRead + mtime invalidation
├── tests/selector.test.ts
├── styles.css
├── manifest.json
├── versions.json
├── esbuild.config.mjs
├── tsconfig.json
└── package.json

~/Git/obsidian-dev-vault/.obsidian/plugins/
└── bases-content-cards -> ~/Git/obsidian-bases-content-cards   (symlink)
```

The repo lives with the other projects in `~/Git/`, not buried inside a vault. Obsidian
follows the symlink without trouble.

## Setup

```sh
# 1. Repo from the official template (GitHub "Use this template",
#    or clone it directly and throw the history away)
git clone https://github.com/obsidianmd/obsidian-sample-plugin \
    ~/Git/obsidian-bases-content-cards
cd ~/Git/obsidian-bases-content-cards
rm -rf .git && git init
npm install
npm install obsidian@latest --save-dev

# 2. Create the dev vault (an empty folder, opened once in Obsidian)
mkdir -p ~/Git/obsidian-dev-vault/.obsidian/plugins

# 3. Symlink instead of copying
ln -s ~/Git/obsidian-bases-content-cards \
      ~/Git/obsidian-dev-vault/.obsidian/plugins/bases-content-cards

# 4. Put hot-reload next to it
git clone https://github.com/pjeby/hot-reload \
    ~/Git/obsidian-dev-vault/.obsidian/plugins/hot-reload
```

Adjust `manifest.json`: `id: bases-content-cards`, `isDesktopOnly: false` and
`minAppVersion: "1.10.2"` — `createFileForView` only exists from 1.10.2 onwards; without that
function `1.10.0` is enough.

Enable both plugins in the dev vault's community plugin settings.

## The loop

```sh
npm run dev     # esbuild in watch mode, src/main.ts -> main.js
```

Save → esbuild rebuilds → hot-reload notices the changed `main.js` and switches the plugin off
and on again after about 0.75 s. No restart, no clicking through settings.

Hot-reload recognises the plugins it should watch by a `.git` folder **or** a `.hotreload` file
in the plugin directory. Through the symlink `.git` is visible, so it should kick in by
itself; if it does not, `touch .hotreload` in the repo (and add it to `.gitignore`).

Two things break the loop:

- **Changes to `manifest.json`** only take effect after restarting Obsidian.
- **A view of your own type that is already open** may still be holding the old class after the
  reload. When in doubt, switch to another view in the `.base` and back. The precondition for
  hot-reload working cleanly at all is a proper `onunload()` — the `register*()` methods of
  `Plugin` clean up after themselves, nothing else does.

Devtools with `Cmd+Alt+I`. In the dev build esbuild writes inline source maps, so breakpoints
land in `.ts`.

## Test data in the dev vault

```sh
node scripts/seed-dev-vault.mjs                              # 120 notes + Dev.base
node scripts/seed-dev-vault.mjs ~/Git/obsidian-dev-vault 600 # the load case
```

Deliberately **synthetic rather than copied**. What matters here is the spread of note lengths
— that is what decides whether the `file.size` estimate holds up. The script produces empty
notes, one-liners, medium and long ones, plus `## Fazit` sections and block IDs, so that every
selector can be tried out. An empty card should look empty, not broken.

If real notes after all: always a **copy** of a slice, never a symlink to the production vault.
Otherwise a bug in the plugin writes into the vault, and that gets auto-committed.

## Testing without Obsidian

`selector.ts` imports nothing from `obsidian` — parse selectors, cut off frontmatter, slice out
a section. That is the logic with the most edge cases, and it runs under `node --test` (or
Vitest) without Obsidian.

The rule of thumb for day-to-day work: **edge cases in tests, appearance in the dev vault.**
Trying selector edge cases in a running Obsidian wastes most of the time.

What tests need: `CachedMetadata` fixtures (`frontmatterPosition`, `headings[]`, `sections[]`)
— you can grab those from the dev vault's devtools console
(`app.metadataCache.getFileCache(app.workspace.getActiveFile())`) and store them as JSON.

## Releasing

1. `npm version patch|minor` — the bundled `version-bump.mjs` writes the new version into
   `manifest.json` and records it together with `minAppVersion` in `versions.json`.
2. Push the tag.
3. `npm run build`. A release is three files: `main.js`, `manifest.json`, `styles.css`.
4. **Install into the real vault as a copy, not as a symlink.** The production vault should
   only ever see builds you deliberately made — a symlink makes it track whatever is on disk,
   and this vault auto-commits:

   ```sh
   npm run install-to-vault -- "$HOME/Git/Obsidian Vault"
   ```

   The script refuses a path with no `.obsidian` folder, refuses to write through a symlink,
   and refuses to run before `npm run build`.

5. Only once it has proved itself: a PR against `obsidianmd/obsidian-releases` for the
   community catalogue.

Two things that do not work yet, and why they are not in the loop above:

- `.github/workflows/release.yml` builds a draft GitHub release from a tag, but `origin` is a
  self-hosted Forgejo instance, so nothing runs it. It is kept for the day the repo also lives
  on GitHub; until then step 3 is done locally.
- **BRAT is not an install route.** It installs from GitHub releases only. Hence the copy
  script rather than the recommendation in the Obsidian docs.

## Order of the first sessions

1. Setup as above, the plugin registers an empty view that renders "hello". Proves the whole
   chain including hot-reload.
2. `selector.ts` plus tests. No Obsidian, hence quick.
3. Cards with `file.name` and cover `:` — the first real view.

From here on the plan in [plan-content-cards.md](plan-content-cards.md) applies.
