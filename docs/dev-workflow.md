# Dev workflow

How to build, run and release `bases-content-cards`. What the API offers:
[bases-api.md](bases-api.md). Why the plugin is shaped as it is:
[decisions.md](decisions.md).

Needs Node 22.18 or later — the test suite runs TypeScript through Node's type stripping — and
Obsidian 1.10.0 or later for the Bases view API. The `obsidian` npm package carries the Bases
types.

## Ground rule: a separate dev vault

The documentation is unusually blunt on this point:

> "one mistake can lead to unintended changes to your vault. To prevent data loss, you
> should never develop plugins in your main vault."

Worth taking literally if your vault syncs or auto-commits: a plugin that touches files while
being tested writes that into the history unasked.

So: a second vault, e.g. `~/Git/obsidian-dev-vault/`.

## Layout

```
~/Git/obsidian-bases-content-cards/        ← the git repo
├── src/
│   ├── main.ts            registration
│   ├── options.ts         what the Bases options panel offers
│   ├── params.ts          reading those options back, span arithmetic
│   ├── view.ts            the BasesView: observers, covers, fitting pass
│   ├── cards.ts           a card's DOM and its click target
│   ├── memory.ts          where the reader is, per tab
│   ├── selector.ts        pure functions, no Obsidian import
│   ├── search.ts          excerpt windows, no Obsidian import
│   ├── tint.ts            the per-note hue
│   └── contentCache.ts    cachedRead + mtime invalidation
├── tests/                 one file per module, run by node --test
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
# 1. The repo and its dependencies
cd ~/Git/obsidian-bases-content-cards
npm install

# 2. Create the dev vault (an empty folder, opened once in Obsidian)
mkdir -p ~/Git/obsidian-dev-vault/.obsidian/plugins

# 3. Symlink instead of copying
ln -s ~/Git/obsidian-bases-content-cards \
      ~/Git/obsidian-dev-vault/.obsidian/plugins/bases-content-cards

# 4. Put hot-reload next to it
git clone https://github.com/pjeby/hot-reload \
    ~/Git/obsidian-dev-vault/.obsidian/plugins/hot-reload
```

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
notes, one-liners, medium and long ones, plus `## Summary` sections and block IDs, so that every
selector can be tried out. An empty card should look empty, not broken.

If real notes after all: always a **copy** of a slice, never a symlink to the vault you
actually use. Otherwise a bug in the plugin writes into notes you cannot afford to lose.

## Testing without Obsidian

Anything that imports `obsidian` only as a *type* runs under `node --test` without Obsidian:
`selector.ts` and `search.ts` (which import nothing from it at all), plus `params.ts`,
`memory.ts` and `tint.ts`. That covers the arithmetic with the most edge cases — addressing a
region, moving match offsets into an excerpt, grading bytes into a row span, and what a tab
remembers of a grid.

Two things follow, and both are cheap to keep to. Relative imports carry their `.ts` extension,
because Node resolves real files while esbuild and `tsc` accept either. And constructor
parameter properties (`constructor(private readonly app: App)`) are written out as fields,
because strip-only mode refuses them — it deletes types, it does not emit code.

The rule of thumb for day-to-day work: **edge cases in tests, appearance in the dev vault.**
Trying selector edge cases in a running Obsidian wastes most of the time.

What tests need: `CachedMetadata` fixtures (`frontmatterPosition`, `headings[]`, `sections[]`)
— you can grab those from the dev vault's devtools console
(`app.metadataCache.getFileCache(app.workspace.getActiveFile())`) and store them as JSON.

## Where the code lives

`origin` is a self-hosted Gitea instance, and that is the source of truth. A push mirror
copies `main` and the tags to `https://github.com/iCaotix/obsidian-bases-content-cards`,
which exists for the two things that only exist on GitHub: releases BRAT and Obsidian can
install from, and the community directory, which verifies ownership through a GitHub
account and reads `manifest.json` from the default branch of a GitHub repo.

**Nothing is merged on GitHub.** A push mirror overwrites, so a commit made or a PR merged
there is gone on the next sync. Anything that arrives that way has to be applied on Gitea
instead. Issues and discussions are fine.

The mirror must be set to push tags, or the release workflow never fires. In Gitea:
Settings → Repository → Mirror Settings → push mirror, with an SSH deploy key or a PAT that
has `contents: write` on the GitHub side.

## Releasing

1. `npm version patch|minor|major` — the bundled `version-bump.mjs` writes the new version
   into `manifest.json` and records it with `minAppVersion` in `versions.json`. Commit those.
2. Push the tag to Gitea. The mirror carries it to GitHub, and
   `.github/workflows/release.yml` builds it there: `npm ci`, typecheck, lint, tests, bundle,
   then a **draft** release with `main.js`, `manifest.json` and `styles.css` attached.
3. Check the draft, then publish it. A release is exactly those three files — the tag name is
   the bare version, `1.0.0` and not `v1.0.0`, because that is what Obsidian's installer
   expects.

If the runner is unavailable, the same three files come out of `npm run build` locally and can
be attached by hand.

Into a vault of your own, at any point:

```sh
npm run install-to-vault -- "/path/to/your/vault"
```

Always a copy, never a symlink — a vault you actually use should only ever see builds you
deliberately made. The script refuses a path with no `.obsidian` folder, refuses to write
through a symlink, and refuses to run before `npm run build`.

**BRAT installs from GitHub releases only**, which is the practical reason the mirror has to
carry tags at all.

## Community directory

Submission is no longer a PR against `obsidianmd/obsidian-releases`. It happens in the
developer dashboard at [community.obsidian.md](https://community.obsidian.md), and every
version is scanned automatically after that — not just the first one.

What the directory reads:

- **`manifest.json` at the HEAD of the GitHub mirror's default branch.** That is what the
  entry's metadata comes from, so it has to be committed and pushed, not only attached to a
  release.
- **The GitHub release whose tag equals `manifest.version`.** That is where users' installs
  actually download `main.js`, `manifest.json` and `styles.css` from. Both have to line up.
- **`README.md`**, an excerpt of which is shown on the public listing page. Relative links
  and images (`./docs/screenshot.png`) are rewritten to resolve against the repo, so they may
  stay relative.

The steps, once per plugin:

1. Sign in at [community.obsidian.md](https://community.obsidian.md) with an Obsidian
   account, and connect the GitHub account that owns the mirror — that is how ownership is
   verified.
2. **Plugins → New plugin**, give it the mirror's URL, agree to the developer policies.
3. The automated review answers within minutes; fixes are shipped as a new release with an
   incremented version, not by re-submitting.

The checks worth passing before submitting are the ones `eslint-plugin-obsidianmd` already
runs in `npm run lint` — it is the same rule set the automated review applies, so a clean
`npm run lint` is the local dry run.

Two rules that are easy to trip over later:

- `minAppVersion` must be a version that really is the minimum. Ours is `1.10.0` because that
  is when `registerBasesView` arrived.
- `fundingUrl` belongs in the manifest **only** if donations are actually accepted. Absent is
  correct here.
