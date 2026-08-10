# Roadmap

Where this could go after v1. Design and the decisions already taken:
[plan-content-cards.md](plan-content-cards.md), what the API does and does not allow:
[bases-api.md](bases-api.md).

Nothing here is promised. The order is by confidence, not by date: the first section is work
whose shape is already clear, the second needs a decision before it can be started, and the
third is written down mainly so it stops being proposed.

The one thing everything is measured against: **this is a view for seeing what notes say.**
Bases supplies the filtering, sorting and grouping, and a click supplies the note itself. A
feature that reimplements either of those is not a feature of this plugin.

---

## 1. Editing the fields under the cover

The largest single thing missing, and the one that has been asked for. Today the footer is
`value.toString()` in a span. Other views — the built-in table above all — let you type into
a property without leaving the view, and a card that shows a status and cannot change it is
half a tool.

**The cover stays read-only.** That is the line, and it is the same one v1 drew for a
different reason. A cover is an excerpt of a body that lives somewhere else; editing it means
writing back into a range of a file that may have moved since it was read, which is the one
risk the card design was chosen to avoid ([plan-content-cards.md](plan-content-cards.md),
"What the table design loses"). Metadata has none of that problem: a property is addressed by
name, and Obsidian already owns the write.

Note that this reverses the v1 note that "nobody expects to edit a card". That was true of the
*cover*, and was allowed to stand for the whole card because nothing then distinguished them.
It does not survive the distinction.

### What is actually editable

`BasesEntry` has `getValue()` and no setter, so nothing here goes through Bases. The write is
ours to make, and only some of what the footer shows can take one:

| Property | Editable | How |
| --- | --- | --- |
| `note.*` | Yes | `fileManager.processFrontMatter()` — frontmatter is the whole of it |
| `file.name` | As a rename | `fileManager.renameFile()`, which also rewrites every link to it |
| `file.tags` | Partly | Frontmatter tags yes; tags written inline in the body are body text |
| `file.mtime`, `file.size`, `file.path`, … | No | Derived from the file. There is nothing to set |
| `formula.*` | No | Computed from other properties. Editing one means editing its inputs |

So the honest description of the feature is **frontmatter editing**, plus rename, and every
non-editable field has to look non-editable rather than accept a keystroke and lose it.

### The three parts that are not obvious

**Empty properties have nowhere to go.** The footer skips a property whose value is falsy, so
the fields most worth filling in are exactly the ones not on the card. Editing needs a slot
for a property that has no value yet — which means the footer gains empty rows, on every card,
for every property in the view's order. That is a visible change to how the deck reads, not an
implementation detail, and it probably wants to be conditional: empty slots while an "edit
fields" mode is on, and the current tight footer when it is off.

**A click on the card opens the note.** All of it, deliberately —
`makeOpenable()` already carries exceptions for links inside a rendered cover and for a click
that ends a text selection. An input is a third, and a longer one: click to focus, drag to
select, Escape to abandon, Enter to commit, and none of them may reach the card.

**The write comes back as a full rebuild, and takes the focus with it.** Saving a property
fires `metadataCache.on('changed')`, Bases re-runs its query, and `onDataUpdated()` empties
`resultsEl` and builds every card again — with the input the user is typing in among the
elements it throws away. The search box dodges this by living outside the part that gets
emptied; a per-card field cannot. Options, roughly in order of how much they cost:

- Commit on blur only, so the rebuild lands after the field is done. Cheap, and gives up
  seeing a formula react as you type.
- Re-focus after the rebuild, keyed by path and property, the way the scroll anchor is keyed
  by path. Restores the caret position too, or it is not worth doing.
- Patch the one card in place when the change is one we made ourselves, and rebuild only for
  changes from elsewhere. Fastest, and the most ways to drift out of step with Bases.

And a property that the view sorts, groups or filters on will move its own card, or remove it
from the base, the moment it is committed. Nothing can prevent that. The scroll anchoring
already keeps the grid still around it, so the remaining question is only whether the card
should be allowed to vanish under the cursor without a word.

### Types

Text, number, checkbox, date, list, tags and links each want a different control, and getting
this wrong is worse than the span it replaces: a date field that stores `2026-8-1` because it
was a text box has corrupted the property for every other view. Obsidian knows the assigned
type through `app.metadataTypeManager`, which is not part of the public API — so either take
the dependency knowingly and degrade to a text box when it is missing, or infer the type from
the current value and accept being wrong about empty ones.

Start with text, number and checkbox — the three that are unambiguous — and leave the rest
rendering as they do now.

---

## 2. Worth doing, smaller

**Keep the search query per tab.** The scroll position now survives opening a note and coming
back; the query does not, so returning from a search result lands you in the full base with an
empty box. It belongs in the same per-leaf memory, and the pre-search position is already
being held next to where it would go. The open question is whether a restored query should
also restore the scroll position *within the results*, or start them at the top.

**A right-click menu.** `workspace.trigger('file-menu', …)` gives a card the same menu the
file explorer has — rename, move, delete, copy link, plus whatever other plugins have added —
for a few lines. Probably the best value-per-line left in the plugin.

**Keyboard navigation.** The grid is mouse-only. Arrow keys between cards, Enter to open,
Space for the hover preview that already exists. This is also most of what the view needs to
be usable with a screen reader, which it currently is not: a card is a `div` that happens to
have a click handler.

**Selector fallbacks.** `#Summary` on a note with no such heading gives an empty cover. A
chain — `#Summary : ` — would fall back to the body, which is what a mixed base wants. Cheap,
because `resolveSelector` already returns nothing identifiably, and it is tested in plain Node.

**A cover from the note's first image.** The built-in Cards view takes an image from a
property; this one could take the first embed in the body, which is the same idea without the
property. Under, over or instead of the excerpt. It is the closest thing to the plugin's own
premise that is not yet built — and it is the one feature that makes it a replacement for the
built-in view rather than a complement to it.

**Per-note overrides beyond the selector.** The cover selector can already be overridden by a
property. A tint override would go the same way, for a base where the colour should mean
something instead of being a hash of the path.

---

## 3. Needs a decision first

**Virtualisation.** Every card is in the DOM, so a base of several thousand notes builds
several thousand elements before it shows anything. Windowing is the standard answer and it
fights everything this view does: heights are guesses until the note is read, the scroll
anchor is hit-tested against real elements, and the remembered spans exist precisely so a
rebuilt grid does not have to guess. A card recycled out of the DOM has no rect to hit-test
and no height to remember. Feasible — the span memory is most of what a virtual list needs —
but it is a rewrite of the fitting pass, not an addition to it. Worth measuring where the real
cliff is before assuming it needs solving.

**A persistent content cache.** The first search reads every note in the base, and the cache
dies with the view. Persisting the stripped haystacks would make it instant on the second
open, at the cost of a store to invalidate on `mtime` and a copy of the vault's text on disk.
Only worth it if the first search actually hurts on a large base.

**Bulk actions.** Shift-click a range, then tag, move or delete all of it. Genuinely missing
from Bases, and genuinely a different plugin: selection state, an action bar, and undo for
operations that touch dozens of files. Named here so the "just add multi-select" version does
not get built by accident.

**Plugin-level defaults.** Every option is per view, so a new view starts from the built-in
defaults rather than the ones you always pick. A settings tab would fix that and is the first
thing in this plugin that would need one.

---

## 4. Not planned

**Editing the cover.** Section 1 explains why. It is worth restating as its own line, because
it will be asked for as soon as the fields are editable.

**Reimplementing filter, sort or group.** Bases supplies all three through its toolbar, and
the view receives the data already filtered and sorted. Anything added here would be a second,
worse copy in a second place.

**Export.** Bases has copy-to-clipboard and CSV export per view already
([bases-api.md](bases-api.md), §5). Only *automatic* export on change is missing, and that is
not a card view's job.

**Custom formula functions.** There is no API for them. The wish exists as a forum thread and
nothing more.
