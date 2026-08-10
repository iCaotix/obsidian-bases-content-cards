# The Bases API — what is actually there

What the plugin API offers a Bases view, and what it does not. This is the reference the
plugin's shape follows from; the choices themselves are in [decisions.md](decisions.md).

As of 2026-08-10, checked against `obsidian.d.ts` (branch `master`, obsidianmd/obsidian-api),
the developer docs and the help pages. Everything named below is `@since 1.10.0`.

## 1. The only extension point is the view type

There is exactly one Bases registration in the whole plugin API:

```ts
// Plugin
registerBasesView(viewId: string, registration: BasesViewRegistration): boolean;

interface BasesViewRegistration {
    name: string;                 // display name in the view switcher
    icon: IconName;
    factory: BasesViewFactory;    // (controller, containerEl) => BasesView
    options?: (config: BasesViewConfig) => BasesAllOptions[];
}
```

There is **no** `registerBasesFunction`, **no** registration of virtual properties and **no**
data-source hook. A plugin can therefore neither add a column to the built-in table nor
supply a formula function of its own. The wish for a function API exists as a forum thread
but has not been implemented
(<https://forum.obsidian.md/t/bases-api-for-plugins-to-add-custom-functions/109612>).

## 2. What a custom view gets

```ts
abstract class BasesView extends Component {
    abstract type: string;
    app: App;
    config: BasesViewConfig;          // options + order + sorting
    allProperties: BasesPropertyId[];
    data: BasesQueryResult;           // REPLACED on every change, not mutated
    abstract onDataUpdated(): void;   // the only render hook
    createFileForView(baseFileName?, frontmatterProcessor?): Promise<void>;  // since 1.10.2
}

class BasesEntry implements FormulaContext {
    file: TFile;
    getValue(propertyId: BasesPropertyId): Value | null;   // synchronous
}

class BasesQueryResult {
    data: BasesEntry[];
    get groupedData(): BasesEntryGroup[];   // filtered, sorted, grouped — ready to use
    get properties(): BasesPropertyId[];
    getSummaryValue(...): Value;
}

class BasesViewConfig {
    get(key), set(key, value)            // the view's own options
    getAsPropertyId(key), getEvaluatedFormula(view, key)
    getOrder(): BasesPropertyId[]        // visible columns, set by the user via the toolbar
    getSort(), getDisplayName(propertyId)
}

type BasesPropertyId = `${'note' | 'formula' | 'file'}.${string}`;
```

Important when estimating the work: **the UI for filtering, sorting, grouping and picking
properties is supplied by Bases itself, through its toolbar.** The view receives the data
already filtered, sorted and grouped. All that is left to build is the rendering.

`onDataUpdated()` is synchronous. Anything asynchronous (reading file content) has to go
through a cache plus a later repaint.

## 3. Bases cannot see note content

Built-in properties (Help → Bases syntax):

`file.name`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`,
`file.tags`, `file.links`, `file.embeds`, `file.backlinks`, `file.properties`, `file.file`

There is **no** `file.content` / `file.body` and no function that reads body text. As far as
the query engine is concerned, the body of a note does not exist. Anyone who needs it has to
fetch it themselves via `vault.cachedRead(file)`.

Useful for addressing sections without parsing the text:
`metadataCache.getFileCache(file)` returns `frontmatterPosition`, `headings[]` and
`sections[]`, each with line and offset information.

For display: `MarkdownRenderer.render(app, markdown, el, sourcePath, component)`.

## 4. The comparison with images

The Cards view renders images from a property ("gallery-like views with images"). That is not
a generic mechanism a plugin could reuse for other content types — it is special-case logic
inside the built-in view. The analogy holds as a *UX model*, not as a technical route.

## 5. Export is already built in

Bases has two export paths per view (Help → Bases views):

- **Copy to clipboard** — as a Markdown table, or for spreadsheets
- **CSV export** — saves the current view as CSV

Both are triggered manually. The only thing missing is *automatic* writing on every change.

## 6. Prior art

| Project | Approach | Relevance |
| --- | --- | --- |
| [CodyBontecou/obsidian-bases-preview](https://github.com/codybontecou/obsidian-bases-preview) | **MutationObserver + DOM injection** of a `<td>` column into the built-in table; reads via `vault.cachedRead()`, strips frontmatter, optionally a single heading, truncates to N characters | Note content in the built-in table, by the only route there is — and evidence that the route is not a clean one |
| [xiwcx/obsidian-bases-kanban](https://github.com/xiwcx/obsidian-bases-kanban) | a real `registerBasesView` view (kanban, drag & drop) | Reference implementation for a custom view type |
| [dsebastien/obsidian-life-tracker-base-view](https://github.com/dsebastien/obsidian-life-tracker-base-view) | custom view plus thorough documentation on building views | Second reference |
| GoodBases | a collection of additional view types | Reference |

DOM injection has the drawbacks you would expect: it depends on the internal HTML of Bases,
does not reliably survive a re-render, column width and position cannot be persisted, and it
reaches into *every* table instead of one deliberately chosen view.

## Sources

- <https://docs.obsidian.md/plugins/guides/bases-view>
- <https://docs.obsidian.md/Reference/TypeScript+API/BasesViewRegistration>
- <https://github.com/obsidianmd/obsidian-api> (`obsidian.d.ts`, master)
- <https://obsidian.md/help/bases/syntax>
- <https://obsidian.md/help/bases/views>
- <https://deepwiki.com/obsidianmd/obsidian-api/4.2-bases-system>
- <https://forum.obsidian.md/t/bases-api-for-plugins-to-add-custom-functions/109612>
