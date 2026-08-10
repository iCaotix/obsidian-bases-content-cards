# Bases-API — Faktenlage

Stand: 2026-08-10. Geprüft gegen `obsidian.d.ts` (Branch `master`, obsidianmd/obsidian-api),
die Entwicklerdoku und die Help-Seiten. Lokal installiert: **Obsidian 1.13.4** — alles unten
Genannte (`@since 1.10.0`) ist damit verfügbar.

## 1. Der einzige Erweiterungspunkt ist der View-Typ

In der gesamten Plugin-API gibt es genau eine Bases-Registrierung:

```ts
// Plugin
registerBasesView(viewId: string, registration: BasesViewRegistration): boolean;

interface BasesViewRegistration {
    name: string;                 // Anzeigename im View-Umschalter
    icon: IconName;
    factory: BasesViewFactory;    // (controller, containerEl) => BasesView
    options?: (config: BasesViewConfig) => BasesAllOptions[];
}
```

Es gibt **kein** `registerBasesFunction`, **keine** Registrierung virtueller Properties und
**keinen** Data-Source-Hook. Ein Plugin kann also weder eine neue Spalte in die eingebaute
Tabelle einhängen noch eine eigene Formel-Funktion bereitstellen. Der Wunsch nach einer
Funktions-API existiert als Forum-Thread, ist aber nicht umgesetzt
(<https://forum.obsidian.md/t/bases-api-for-plugins-to-add-custom-functions/109612>).

## 2. Was ein eigener View bekommt

```ts
abstract class BasesView extends Component {
    abstract type: string;
    app: App;
    config: BasesViewConfig;          // Optionen + Reihenfolge + Sortierung
    allProperties: BasesPropertyId[];
    data: BasesQueryResult;           // wird bei jeder Änderung ERSETZT, nicht mutiert
    abstract onDataUpdated(): void;   // einziger Render-Hook
    createFileForView(baseFileName?, frontmatterProcessor?): Promise<void>;  // seit 1.10.2
}

class BasesEntry implements FormulaContext {
    file: TFile;
    getValue(propertyId: BasesPropertyId): Value | null;   // synchron
}

class BasesQueryResult {
    data: BasesEntry[];
    get groupedData(): BasesEntryGroup[];   // gefiltert, sortiert, gruppiert — fertig
    get properties(): BasesPropertyId[];
    getSummaryValue(...): Value;
}

class BasesViewConfig {
    get(key), set(key, value)            // eigene View-Optionen
    getAsPropertyId(key), getEvaluatedFormula(view, key)
    getOrder(): BasesPropertyId[]        // sichtbare Spalten, vom Nutzer per Toolbar gesetzt
    getSort(), getDisplayName(propertyId)
}

type BasesPropertyId = `${'note' | 'formula' | 'file'}.${string}`;
```

Wichtig für die Aufwandsschätzung: **Filter-, Sortier-, Gruppier- und Property-Auswahl-UI
liefert Bases selbst über seine Toolbar.** Der View bekommt die Daten bereits gefiltert und
sortiert. Selbst zu bauen ist nur das Rendering: Zellen, Kopfzeile, Spaltenbreiten,
Inline-Editing.

`onDataUpdated()` ist synchron. Alles Asynchrone (Dateiinhalt lesen) muss über Cache +
Nachrendern laufen.

## 3. Bases kann Notizinhalt nicht sehen

Verfügbare eingebaute Properties (Help → Bases syntax):

`file.name`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`,
`file.tags`, `file.links`, `file.embeds`, `file.backlinks`, `file.properties`, `file.file`

Es gibt **kein** `file.content` / `file.body` und keine Funktion, die Fließtext liest. Der
Body einer Notiz ist für die Query-Engine schlicht nicht existent. Wer ihn braucht, muss ihn
selbst über `vault.cachedRead(file)` holen.

Nützlich zum Adressieren von Abschnitten, ohne den Text zu parsen:
`metadataCache.getFileCache(file)` liefert `frontmatterPosition`, `headings[]` und
`sections[]` — jeweils mit Zeilen- und Offset-Angaben.

Zum Anzeigen: `MarkdownRenderer.render(app, markdown, el, sourcePath, component)`.

## 4. Der Bilder-Vergleich aus der Idee

Cards-View rendert Bilder aus einer Property ("gallery-like views with images"). Das ist aber
kein generischer Mechanismus, den ein Plugin für andere Inhaltstypen mitbenutzen könnte —
es ist Sonderlogik im eingebauten View. Die Analogie trägt als *UX-Vorbild*, nicht als
technischer Weg.

## 5. Export ist bereits eingebaut

Bases hat pro View zwei Exportwege (Help → Bases views):

- **Copy to clipboard** — als Markdown-Tabelle bzw. für Tabellenkalkulationen
- **CSV export** — speichert die aktuelle View als CSV

Beides manuell angestoßen. Was fehlt, ist ausschließlich das *automatische* Schreiben bei
jeder Änderung.

## 6. Vorhandene Arbeiten

| Projekt | Ansatz | Relevanz |
| --- | --- | --- |
| [CodyBontecou/obsidian-bases-preview](https://github.com/codybontecou/obsidian-bases-preview) | **MutationObserver + DOM-Injektion** einer `<td>`-Spalte in die eingebaute Tabelle; liest per `vault.cachedRead()`, schneidet Frontmatter ab, optional nur ein Heading, kürzt auf N Zeichen | Macht praktisch genau Idee A — aber über den fragilen Weg. Belegt zugleich, dass es sauber nicht geht. |
| [xiwcx/obsidian-bases-kanban](https://github.com/xiwcx/obsidian-bases-kanban) | echter `registerBasesView`-View (Kanban, Drag & Drop) | Referenzimplementierung für einen eigenen View-Typ |
| [dsebastien/obsidian-life-tracker-base-view](https://github.com/dsebastien/obsidian-life-tracker-base-view) | eigener View + ausführliche Doku zum View-Bau | Zweite Referenz |
| GoodBases | Sammlung zusätzlicher View-Typen | Referenz |

Die DOM-Injektion hat die erwartbaren Nachteile: hängt am HTML-Aufbau von Bases, überlebt
kein Re-Render zuverlässig, Spaltenbreite/-position sind nicht persistierbar, und sie greift
in *jede* Tabelle ein statt in eine bewusst gewählte View.

## Quellen

- <https://docs.obsidian.md/plugins/guides/bases-view>
- <https://docs.obsidian.md/Reference/TypeScript+API/BasesViewRegistration>
- <https://github.com/obsidianmd/obsidian-api> (`obsidian.d.ts`, master)
- <https://obsidian.md/help/bases/syntax>
- <https://obsidian.md/help/bases/views>
- <https://deepwiki.com/obsidianmd/obsidian-api/4.2-bases-system>
- <https://forum.obsidian.md/t/bases-api-for-plugins-to-add-custom-functions/109612>
