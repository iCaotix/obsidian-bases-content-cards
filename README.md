# Bases Content Cards

An Obsidian [Bases](https://help.obsidian.md/bases) view that shows notes as cards — using
the **note's own content as the cover**, where the built-in Cards view puts an image.

Bases can tell you a note's name, tags and dates. It cannot show you a single sentence of
what the note actually says: there is no `file.content`, and no way for a plugin to add a
column to the built-in table. This view reads the body itself and puts it where you can
see it.

```
┌────────────────┐  ┌────────────────┐
│  Excerpt from  │  │  Short note    │
│  the note's    │  ├────────────────┤
│  body          │  │  Title         │
│                │  │  tags · link   │
├────────────────┤  └────────────────┘
│  Title         │  ┌────────────────┐
│  tags · link   │  │  Medium note   │
└────────────────┘  │                │
                    ├────────────────┤
                    │  Title         │
                    └────────────────┘
```

Requires Obsidian 1.10.0 or later (the Bases view API).

## Install

Not in the community catalogue yet, so install it by hand:

```sh
npm install
npm run build
npm run install-to-vault -- "/path/to/your/vault"
```

That copies `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/bases-content-cards/`. Enable **Bases Content Cards** under
Settings → Community plugins, then add a **Content cards** view to any `.base`.

To update, run the same three commands again and reload Obsidian.

## What it does

- **Content as cover.** Whole body, a named section (`#Fazit`), or a block (`^abc123`).
- **Cards sized to their content.** Height comes from the note's file size *before* anything
  is read, so cards claim the right space up front and the grid does not jump as text
  arrives. Once the text is there the card is measured and fitted to it — and measured again
  whenever the columns change width.
- **Everything else stays Bases.** Filters, sorting, grouping and which properties appear
  under the cover all come from the normal Bases toolbar.
- **Click anywhere on a card** to open its note; Cmd-click or middle click opens a new tab.
  Links inside a markdown-rendered cover still go where they point.

## Options

Set per view, in the Bases view config:

| Option | Meaning |
| --- | --- |
| Cover | `:` whole body · `#Heading` a section · `^block-id` a block · `12:20` line range |
| Cover override property | A note property whose value replaces the cover selector for that note |
| Cover length | Characters before truncation (default 300) |
| Render markdown | Off by default — plain text is faster and reads fine at excerpt size |
| Card height | Fit to content, or uniform |
| Maximum card height | Small…extra large, or unlimited — a card then grows to fit its whole cover |

Line ranges are supported but discouraged: they silently point somewhere else as soon as a
note is edited above them. Headings and block IDs survive editing.

**Quote the value in frontmatter.** Selectors collide with YAML syntax — a bare `:` is
invalid, and a bare `#` starts a comment, so the property ends up empty and the view falls
back to its own setting:

```yaml
---
cover: ":"        # not  cover: :
---
```

```yaml
---
cover: "#Fazit"   # not  cover: #Fazit
---
```

## Development

```sh
npm install
npm run dev     # esbuild watch → main.js
npm test        # selector logic, runs in Node without Obsidian
npm run build   # typecheck + production bundle
npm run lint
```

`src/selector.ts` has no Obsidian imports — the addressing logic, which has by far the most
edge cases, is tested in plain Node. Edge cases in tests, appearance in the dev vault.

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full setup (separate dev vault,
symlink, hot reload, releasing).

## Docs

| Document | Contents |
| --- | --- |
| [docs/evaluation.md](docs/evaluation.md) | Why this shape, and which alternatives were rejected |
| [docs/bases-api.md](docs/bases-api.md) | What the Bases plugin API does and does not offer, with sources |
| [docs/plan-content-cards.md](docs/plan-content-cards.md) | Design and implementation order |
| [docs/dev-workflow.md](docs/dev-workflow.md) | Repo layout and day-to-day workflow |

## Status

0.1.0 — ready to use in a real vault, not yet in the community catalogue. The view is
read-only: it never writes to the vault.

Known limits:

- Non-markdown files in a base (attachments) show as cards with no cover. There is nothing to
  read from them.
- Cards do not slide up into the gap at the end of a row. That is the price of laying them
  out with grid spans rather than JS — see [docs/plan-content-cards.md](docs/plan-content-cards.md).
- `coverSource: auto` (a note's first image as the cover) is designed but not built.
