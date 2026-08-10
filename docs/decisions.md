# Decisions

The choices that shaped the plugin, and what each one rules out. Newest first, so the file
reads backwards: the top is where it stands today, the bottom is why it is a card view at all.

An entry is here if reversing it would mean rewriting something rather than changing a
setting. Options are not decisions — those are in the [README](../README.md). Things not
decided yet are in [roadmap.md](roadmap.md).

---

## 2026-08-10 — Gitea is the source of truth, GitHub is a mirror

Development happens on a self-hosted Gitea instance; a push mirror copies `main` and the tags
to GitHub. GitHub exists because the things Obsidian users need only exist there: releases
that BRAT can install from, and the community catalogue, whose submission is a PR against a
GitHub repository.

Consequences worth knowing before pushing anything:

- **Nothing is merged on GitHub.** A push mirror overwrites; a PR merged there is lost on the
  next sync. Issues and discussions are fine, code is not.
- **Releases are built by GitHub Actions from the mirrored tag** — the runner is there, and a
  release built from the mirror is provably built from what the mirror contains.
- The mirror must be configured to include tags, or nothing triggers.

Rejected: releasing from Gitea's own CI. It keeps GitHub purely a mirror, but it needs a
GitHub token stored on the Gitea side and reimplements what `release.yml` already does.

## 2026-08-10 — 1.0.0 is read-only, and says so

The version number is not a claim that the plugin is finished. It is a claim that what it
does, it does properly: the covers, the sizing, the search and the scroll position are all
behaviours that have been used against a real base and fixed where they were wrong.

Editing metadata from the card is the obvious next feature and is deliberately not in it. It
is a different kind of plugin — one that writes — and shipping it half-done would be worse
than not shipping it. The reasoning is in [roadmap.md](roadmap.md) §1.

## 2026-08-10 — Where the reader is, is a note and an offset, never a pixel

Every height in this view is provisional: guessed from `file.size`, corrected once the note is
read, corrected again when the columns change width. So a scroll offset means a different
place in the list every time any of them changes, and the error at any point is the sum of
every guess above it. A card is the same card regardless.

What is stored is therefore the note at the top edge plus how far it has scrolled past it —
together with the spans the tab had already fitted, so the rebuilt grid starts from the
heights it just had instead of guessing again. Kept per leaf in a `WeakMap`, so two tabs on
one base keep their own place and a closed tab takes its entry with it.

This is what makes the position survive the three things that destroy it: opening a note in
the same tab (which replaces the view), an edit elsewhere in the vault (which rebuilds the
grid), and a search (which hides most of it).

## 2026-08-10 — The search is the view's, and does not outlive it

Bases has a search in its toolbar and it already works on these cards, but it can only see the
properties the view is showing, because that is all Bases can see. The box above the grid is
the other half: it reads the body. The two compose, and neither replaces the other.

It is not persisted. A query is a question being asked right now, not a property of the view,
and a base that reopened three days later still filtered by a word nobody remembers typing
would look broken rather than helpful. The scroll position from before the search *is* kept,
because that is the reader's place in the base and not part of the question.

Matched covers are plain text even when markdown rendering is on: a highlight goes around a
range of characters, and rendering scatters those across a tree. Obsidian's own search results
are plain for the same reason.

## 2026-08-10 — A card's colour means nothing, on purpose

The tint is a hash of the note's path, so a card keeps its colour across sorts, filters and
restarts. A colour that moved between notes would be worse than no colour, because it would
look like it meant something.

Twelve hues rather than the full circle — neighbours a few degrees apart are one colour with
extra steps. Defined in oklch and mixed into the theme's own background rather than laid over
it, so one definition holds in light and dark, and so the yellow does not arrive twice as
bright as the blue at identical numbers.

Rejected: a colour from a property. That is a real feature, but it is a different one — it
would mean something, and would then need to be configurable, legible and documented. Filed in
[roadmap.md](roadmap.md).

## 2026-08-10 — Line ranges exist, and are documented as a mistake

The original design addressed content by line range (`12:20`). That is a brittle address: it
points somewhere else the moment a paragraph is inserted above it, silently and with no error.
Obsidian already has stable addresses for exactly this — `#Heading` and `^block-id`.

Ranges are nonetheless implemented, because parsing them costs almost nothing once the
selector module exists and there are covers that genuinely have no heading to hang on. They
are last in the README's list and carry a warning.

## 2026-08-10 — Cards are sized before they are read

Content arrives asynchronously and heights vary per card, which is the combination that makes
a grid jump for seconds while the text trickles in. The fix is to know the height before the
read: `file.size` is a built-in Bases property, available synchronously with no file I/O, and
bytes grade into a row span well enough that the scrollbar is honest from the first frame.

Once the text is there the card is measured and fitted properly, so the estimate only ever has
to be close. It is wrong in two known ways — frontmatter counts towards the file size, and
with a `#Heading` cover the file size says nothing about that section — and in both the
correction absorbs it. That is one jolt instead of a permanent lie, and `Card height: uniform`
remains for anyone who would rather have neither.

This is also what makes lazy reading possible: only cards near the viewport are read, and
because unread cards already know their height, the grid below them is the right size anyway.

## 2026-08-10 — CSS grid with row spans, not masonry

Cards span whole rows of an 8px grid. The alternatives, and why not:

- **`column-count`** fills column one to the bottom, then column two. Bases hands over data
  already sorted; a base sorted by created date would read top-to-bottom instead of
  left-to-right, which is simply wrong.
- **Native CSS masonry** (`display: grid-lanes`) is not usable across the Electron versions
  Obsidian ships. Revisit behind `CSS.supports()` when it is.
- **JS masonry** — shortest-column placement, absolute positioning — leaves no gaps, but costs
  a layout calculation of our own on every resize and blurs the sort order.

The price of the choice is the occasional gap at the end of a row, because cards do not slide
up to fill it. That is the visible difference from Google Keep, and the acceptable half of the
trade.

## 2026-08-10 — The cover is read-only, and a click opens the note

The whole card is one click target — cover, title and properties alike. This is what turns
read-only from a limitation into the expected behaviour: nothing on a card invites typing, and
the note is one click away.

It also removes the riskiest thing in the original design. Editing a cover means writing back
into a region of a file that may have moved since it was read, and getting that wrong destroys
notes. Nothing here writes to the vault at all.

## 2026-08-10 — One cover selector per view, with a per-note override

The first design had a list of content columns. A card has one cover, so the configuration is
one selector — with an optional property that overrides it for a single note, because a rule
that applies to a whole view should not have to be maintained in every note it applies to.

The selector resolution lives in `src/selector.ts` with **no Obsidian imports**. That is
deliberate and worth keeping: it is the part with by far the most edge cases, so it is tested
in plain Node — and if Obsidian ever ships the formula-function API that has been asked for,
it can be handed over unchanged as `content(":")`, usable in every view including the built-in
table.

## 2026-08-10 — Docs in English

Written in German first, translated once the repo was headed for a public mirror. A plugin
whose users are found through the community catalogue cannot document itself in a language
most of them do not read.

## 2026-08-10 — A card view, not a column in the built-in table

The founding decision. The original idea was a content column in the Bases table, the way an
image is a column in the Cards view.

**The plugin API does not allow it.** There is exactly one Bases extension point,
`registerBasesView()` — a complete view type of your own. No virtual properties, no custom
formula functions, no data-source hook. Adding a column to the built-in table means shipping
the table, and almost all of that work is rebuilding the table itself: header row, column
widths, a cell renderer per value type. None of it is the part that matters.

There is prior art doing it anyway, by MutationObserver and DOM injection into the rendered
table. It works, and it hangs off the internal HTML of Bases, survives re-renders only with
contortions, cannot persist a column width, and reaches into every table rather than one
chosen view. As evidence that the need is real it is valuable; as a blueprint it is not.

A card is the better shape for the same need, not a consolation prize: the point was ever
*seeing* what a note says, and three lines of prose are legible in a card and are not in a
table cell. Filtering, sorting, grouping and which properties appear all stay with the Bases
toolbar, so what is left to build is exactly the new part — read the content, trim it, show
it. The built-in table remains the better view for large bases, and several views can live in
one `.base`.

Details of what the API does and does not offer: [bases-api.md](bases-api.md).
