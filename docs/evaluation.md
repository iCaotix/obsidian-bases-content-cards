# Project idea: extending Bases — an evaluation

Starting point: a QuickCapture note in the vault (`QuickCapture/2026-08-10 00.42.13.md`,
written on 2026-08-10). Two ideas, both about Bases.
Facts and sources: [bases-api.md](bases-api.md). Implementation plan for the recommended
option: [plan-content-cards.md](plan-content-cards.md). Repo layout and workflow:
[dev-workflow.md](dev-workflow.md).

**Short version:** idea A is feasible, but not by the route the note sketches — hooking a
column into the *built-in* table is not provided for. Idea B falls into two halves: "Bases
with CSV/JSON as its backend" is impossible, "write the Bases result out to JSONL/CSV
automatically" is possible but 90 % already built in.

---

## Idea A — note content as a column

> You put `:` or `12:20` into a property, the way you do with images, and the content is
> loaded into the column.

**Possible: yes. The way it is described: no.**

Three things stand in the way of the literal design:

1. **There is no way to add a column to the built-in table.** The plugin API has exactly one
   entry point for Bases — `registerBasesView()`, that is, a *complete view type of your
   own*. No virtual properties, no custom formula functions. If you want a content column,
   you ship the table it lives in.
2. **Bases fundamentally cannot see note content.** There is no `file.content`. The body has
   to be fetched by the plugin itself via `vault.cachedRead()` — and that is asynchronous,
   while `getValue()` and `onDataUpdated()` are synchronous. That is not a blocker, but it
   dictates the architecture (cache plus repaint).
3. **Line numbers are a brittle address.** `12:20` points at something else as soon as a
   paragraph is inserted above it — silently, with no error. Obsidian already has stable
   addresses for exactly this problem: `#Heading` and `^block-id`.

There is also prior art: [obsidian-bases-preview](https://github.com/codybontecou/obsidian-bases-preview)
effectively does idea A, via a MutationObserver and DOM injection into the rendered table.
That works, but it hangs off the internal HTML of Bases and only survives re-renders with
contortions. As evidence that the need is real the plugin is valuable; as a blueprint it is
not.

### What came of it: card instead of column

The first design was a custom table view with extra content columns. Almost all of the effort
sat in *rebuilding the table* — header row, column widths, a cell renderer per `Value` type —
and not in the part that matters.

The better cut (Marcel's suggestion): a **card view like Google Keep / Notion**, where the
note content forms the **cover** — where the built-in Cards view shows an image from a
property. Properties underneath. Same idea, in the shape that fits it:

- The point of A is *seeing content*, not the table grid. A card shows three lines of prose
  legibly; a table cell does not.
- **Read-only stops being a compromise and becomes the expected behaviour** — nobody wants to
  type inside a card's cell, a click opens the note. That removes the riskiest part of the
  whole project (writing back into a line range) with nothing to replace it.
- **Line ranges (`12:20`) become unnecessary.** For a cover you want "the start of the note"
  or "the *Conclusion* section" — `:` and `#Heading` cover that, and both survive editing. The
  most brittle idea in the design falls away without leaving a gap.
- N configurable content columns collapse into **one** cover selector. The per-note property
  survives as an *override*, but is not mandatory — you do not want to maintain a rule that
  applies to the whole view in 120 notes individually.
- Which properties appear under the cover still comes from `config.getOrder()`, that is, the
  property picker in the Bases toolbar. Filtering, sorting and grouping likewise.

Each card is as tall as its content demands. The one serious pitfall in that is the
interaction with asynchronous reading: variable heights plus text trickling in make the layout
jump. Solved via `file.size` — a built-in Bases property, available synchronously and without
file I/O, from which the card height can be graded *before* reading. Details and ordering:
[plan-content-cards.md](plan-content-cards.md).

---

## Idea B — Bases with a JSON/CSV backend

The note conflates two directions that end very differently.

### B1: CSV/JSONL *as a data source* for Bases — not possible

There is no data-source hook. Bases always queries the files in the vault; a custom view may
*present* the result, but not decide what it consists of. A JSONL file cannot feed rows into
a base.

The only route there would be the other way round: CSV as the source of truth, and a sync
script that generates a note per row. With ~9 collections in `Databases/` that is technically
feasible, but it costs exactly what makes the vault a vault — free text under the frontmatter,
links, editing inside Obsidian. I would advise against it.

### B2: every Bases entry automatically becomes a row in JSONL/CSV — possible, but mostly already there

Bases already exports: every view has *Copy to clipboard* and *CSV export*. The only thing
missing is **automatic** writing on every change. There are two routes for that:

- **In the plugin:** a view type whose `onDataUpdated()` writes the result out. Advantage: the
  real query engine, filters and formulas included, comes along for free. Watch out: writing
  into the vault fires metadata events — keep the target outside the query (`.jsonl` falls out
  of `file.ext == "md"` anyway) and debounce, or it goes round in circles.
- **Without a plugin:** a script that collects frontmatter across the vault and writes JSONL,
  hooked into a git hook or the existing backup run. Fits what is already in `.agents/tools/`.
  The price: the `.base` filters and formulas would have to be reimplemented — you do not get
  the query language for free from outside.

Both are small projects. But: **what for?** As long as the consumer is undecided (SQL queries
over the vault, analysis, export into another tool, backup), neither the format nor the
trigger point can be pinned down sensibly. For "SQL over the vault" there is already SQLSeal —
which would mean not building anything at all.

---

## Recommendation

1. **Build idea A**, as a custom card view with content as the cover, read-only, with
   heading/block addressing. That is the idea with real day-to-day value — `Knowledgebase.base`
   and the `Databases/*` views show file names and tags today, but never a sentence from the
   note. The table stays alongside it; several views in the same `.base` are supported.
2. **Not idea B in the same project.** It shares neither code nor benefit with A. Settle who
   reads the JSONL first; after that it is probably a 100-line script and not a plugin.
3. **In parallel, push on the actual lever:** if Obsidian ships a function API for Bases (the
   forum thread exists, nothing is implemented), A shrinks to a handful of lines — `content(":")`
   as a formula, usable in *every* view including the built-in table. Hence the plan's
   insistence that the resolution logic be a standalone module with no view dependencies, so
   it can later be handed out unchanged as a formula function.

## Open questions

- What is the JSONL/CSV from B2 supposed to feed? No consumer, no sensible shape.
- Cover for notes that begin with an image: text or image? Filed in the plan as a
  `coverSource: auto` option, but placed behind the core functionality.
