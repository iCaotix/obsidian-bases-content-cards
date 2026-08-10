# Plan: a Bases card view with content as the cover

Working title `bases-content-cards`. Evaluation and alternatives: [evaluation.md](evaluation.md),
API facts: [bases-api.md](bases-api.md).

Replaces the original table plan. Reason: the value of idea A lies in *seeing* the content,
not in the table grid — and as a card it costs a fraction.

## Goal for v1

A view type `content-cards` registered via `registerBasesView()`. One card per note, laid out
like Google Keep or a Notion gallery:

```
┌────────────────┐  ┌────────────────┐
│  Excerpt from  │  │  Short note    │   ← "cover" = note content instead of an image
│  the note's    │  ├────────────────┤     height per card follows the amount of content
│  body          │  │  Title         │
│                │  │  tags · link   │
│                │  └────────────────┘
├────────────────┤  ┌────────────────┐
│  Title         │  │  Medium note   │
│  tags · link   │  │                │   ← properties from config.getOrder()
└────────────────┘  │                │
                    ├────────────────┤
                    │  Title         │
                    │  tags · link   │
                    └────────────────┘
```

The built-in Cards view takes a property as an image cover. Here the cover is text, read from
the note. Everything below it comes unchanged from the Bases toolbar.

## What the table design loses

| Dropped | Why |
| --- | --- |
| Header row, column widths, drag-to-reorder | Cards have no grid |
| A cell renderer per `Value` type | Properties are label/value rows or chips; one renderer is enough |
| Inline editing | Nobody expects to edit a card — a click opens the note. Read-only is not a compromise here, it is the expected behaviour. |
| `contentColumns` as a list | A card has **one** cover, not N content columns. The configuration shrinks to a single selector. |
| Line ranges (`12:20`) | For a cover you want "the start of the note" or "section X". Line numbers solve no problem that occurs here — out of v1. |

What is left of the effort is almost exactly the part that matters: read content, trim it,
show it.

## Configuration

Via `BasesViewRegistration.options`:

- `coverSelector` — default `:` (the whole body without frontmatter, truncated). Also allowed:
  `#Heading`, `^block-id`.
- `selectorProperty` (optional) — a note property that overrides `coverSelector` per note.
  The idea from the original note survives without becoming mandatory.
  **In frontmatter the value must be quoted** — a bare `:` is invalid YAML, a bare `#` starts
  a comment. So `cover: ":"` and `cover: "#Conclusion"`. Without quotes the property is empty
  and the view falls back to its own setting; that is benign, but invisible.
- `coverSource` — `content` | `image` | `auto`. With `auto`: the note's first embed as an
  image, otherwise text. `file.embeds` supplies the candidates without a parser of our own.
- `maxLength` — characters, default 300.
- `renderMode` — `text` (default) | `markdown`.
- `cardSize` — `auto` (default, height per card follows the amount of content) | `uniform`
  (all the same).
- `sizeProperty` (optional) — a note property that forces the card size per note
  (`s` | `m` | `l` | `xl`).
- `maxSize` — an upper bound in grid steps, so that a long note does not take up half the
  column. Default `l`. Plus `unlimited`: the card then grows until the whole cover fits. In
  practice `maxLength` (default 300 characters) limits the height anyway — anyone who really
  wants tall cards has to raise both.
  The fade at the bottom edge only appears when something is actually cut off; with
  `unlimited` that is usually not the case, and fading out complete text would look like a
  fault.

Which properties appear under the cover, and in which order, is still decided by
`config.getOrder()`, that is, the toolbar's property picker. No option of our own is needed
for it.

## Architecture

Unchanged from the table plan, only the view part is smaller:

1. **`selector.ts`** — pure functions, no Obsidian dependency: `parseSelector()`,
   `resolve(content, cache, selector)`. This stays the part that could be handed out unchanged
   as a formula function should Obsidian ship a function API. Frontmatter is cut off via
   `frontmatterPosition`, headings and blocks come from `metadataCache.getFileCache()` — no
   Markdown parser of our own.
2. **`contentCache.ts`** — `Map<path, { mtime, text }>`, filled via `vault.cachedRead()`,
   invalidated by `mtime` and `vault.on('modify')`.
3. **`view.ts`** — the `BasesView`. Renders `data.groupedData`, one card per `BasesEntry`,
   groups as intertitles.
4. **`main.ts`** — registration, styles.

### Per-note card height

Every card should be as tall as its content demands — short note, short card. That is doable,
but it has exactly one catch, and the catch dictates the approach.

**The catch:** content arrives late (`cachedRead` is async). Render the card first and let it
grow afterwards, and every arriving text shoves half the layout around. With 370 notes in
`Knowledgebase.base` the page then jumps for seconds.

**The fix:** *estimate the height before reading*. `file.size` is a built-in Bases property and
available **synchronously** via `entry.getValue('file.size')` — with no file I/O at all. Bytes
→ size step → the card claims its space immediately, correctly graded, and the text merely
fills it in later.

Per card:

1. Read `file.size` (synchronously) → step `s` / `m` / `l` / `xl` → `grid-row: span N`.
2. The note's `sizeProperty` overrides the step, if set.
3. Content arrives → measure once. If the actual height is off by more than one step, correct
   the step once (with a transition), otherwise clamp and be done.
4. On a second render the text is in the cache, so it is there synchronously — and then there
   is no correction at all.

**Limitations, honestly:** `file.size` counts the frontmatter; for short notes with a lot of
frontmatter it overestimates. And with `coverSelector: "#Conclusion"` the file size says
nothing about the length of that section. In both cases step 3 catches it — it jolts once
instead of not at all. That is why `cardSize: uniform` stays as an option: for skimming large
bases densely, equal heights read better anyway.

### Why grid spans and not column masonry

- **CSS `column-count` is out.** Multi-column fills column 1 completely, then column 2 — the
  reading order would run top to bottom instead of left to right. Bases delivers the data
  sorted; a base sorted by `created DESC` would simply look wrong.
- **Native CSS masonry is not usable yet.** The CSSWG settled on `display: grid-lanes`, Safari
  26 shipped it first; in Chromium it is behind a flag, stable expected during 2026. Obsidian
  is Electron/Chromium — so later at the earliest, and then switchable via `CSS.supports()`.
- **Chosen: `display: grid` with `grid-auto-rows: 8px` and `grid-row: span N` per card.** The
  order stays correct row by row, no JS layout, the browser handles resizing. The price: the
  occasional gap at the end of a row, because cards do not slide up. That is the difference
  from real Keep — and the acceptable half of the trade.
- JS masonry (shortest column, absolutely positioned) would leave no gaps, but costs a layout
  calculation of our own on every resize and softens the sort order. Only if the gaps really
  start to hurt.

### More on performance

- Read content only for visible cards (`IntersectionObserver`), not for every hit. The
  `file.size` estimate is what makes that possible in the first place: unread cards know their
  height anyway, so scroll height and scrollbar are right from the start.
- Truncate to `maxLength` *before* rendering.
- `MarkdownRenderer.render()` is expensive — plain text stays the default.
- `data` and the `BasesEntry` objects are recreated on every change: hold no references, key
  the cache by path, reuse DOM nodes instead of `empty()` plus a rebuild.

### Small things with a good ratio

- `createFileForView(name, frontmatterProcessor)` (since 1.10.2) gives you the Keep-style "+"
  card at the end practically for free — prefilled frontmatter included.
- A click opens the note, hover shows the preview. Both are ready-made in the example at
  <https://docs.obsidian.md/plugins/guides/bases-view>.

## Steps

1. Plugin scaffold in a **separate test vault** — not this one, this vault hangs off
   obsidian-git with auto-commit.
2. `selector.ts` plus tests, runnable without Obsidian, hence first.
3. Minimal view: cards with `file.name` and a fixed cover `:`. Proves the async chain end to
   end.
4. Properties under the cover from `config.getOrder()`, groups from `groupedData`.
5. Options: `coverSelector`, `selectorProperty`, `maxLength`.
6. Per-note card height: `file.size` steps → `grid-row: span N`, correction after loading,
   `sizeProperty` as an override. Then lazy loading via `IntersectionObserver`.
7. `coverSource: auto` (image embed as cover), `renderMode: markdown`, `layout: masonry`.
8. Against real data: `Knowledgebase.base` (~370 notes) as the load case,
   `Databases/Meine Software` as the content case — many items there are still empty, and an
   empty cover shows exactly that at a glance.

## Risks

- **Cards scale worse than rows.** 370 cards scroll sluggishly and compare worse than a table.
  Sorting and filtering stay reachable via the toolbar, but the overview is a different one.
  For large bases the built-in table remains the better view — both side by side in the same
  `.base` is explicitly supported.
- **API movement:** Bases is young (view API since 1.10.0, `createFileForView` only since
  1.10.2).
- **Scope:** `coverSource: auto` and `masonry` are the two places where the project can
  expand. Deliberately placed behind step 6.
