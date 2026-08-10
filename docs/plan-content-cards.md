# Plan: Bases-Card-View mit Inhalt als Cover

Arbeitstitel `bases-content-cards`. Bewertung und Alternativen: [evaluation.md](evaluation.md),
API-Fakten: [bases-api.md](bases-api.md).

Ersetzt den ursprünglichen Tabellen-Plan. Grund: der Nutzen von Idee A liegt im *Sehen* des
Inhalts, nicht im Tabellenraster — und als Karte kostet er einen Bruchteil.

## Ziel v1

Ein per `registerBasesView()` registrierter View-Typ `content-cards`. Eine Karte je Notiz,
Aufbau wie Google Keep bzw. Notion-Gallery:

```
┌────────────────┐  ┌────────────────┐
│  Ausschnitt    │  │  Kurze Notiz   │   ← "Cover" = Notizinhalt statt Bild
│  aus dem Body  │  ├────────────────┤     Höhe je Karte nach Inhaltsmenge
│  der Notiz     │  │  Titel         │
│                │  │  tags · Link   │
│                │  └────────────────┘
├────────────────┤  ┌────────────────┐
│  Titel         │  │  Mittellang    │
│  tags · Link   │  │                │   ← Properties aus config.getOrder()
└────────────────┘  │                │
                    ├────────────────┤
                    │  Titel         │
                    │  tags · Link   │
                    └────────────────┘
```

Der eingebaute Cards-View nimmt eine Property als Bild-Cover. Hier ist das Cover Text, aus
der Notiz gelesen. Alles darunter kommt unverändert aus der Bases-Toolbar.

## Was gegenüber dem Tabellen-Entwurf entfällt

| Entfällt | Warum |
| --- | --- |
| Kopfzeile, Spaltenbreiten, Drag-Reorder | Karten haben kein Raster |
| Zellen-Renderer je `Value`-Typ im Grid | Properties sind Label/Wert-Zeilen bzw. Chips, ein Renderer reicht |
| Inline-Editing | Bei einer Karte erwartet niemand Editieren — Klick öffnet die Notiz. Read-only ist hier kein Kompromiss, sondern das erwartete Verhalten. |
| `contentColumns` als Liste | Eine Karte hat **ein** Cover, keine N Inhaltsspalten. Die Konfiguration schrumpft auf einen Selektor. |
| Zeilenbereiche (`12:20`) | Für ein Cover will man "Anfang der Notiz" oder "Abschnitt X". Zeilennummern lösen kein Problem, das hier auftritt — raus aus v1. |

Damit bleibt vom Aufwand fast nur noch das übrig, worum es eigentlich geht: Inhalt lesen,
zuschneiden, anzeigen.

## Konfiguration

Über `BasesViewRegistration.options`:

- `coverSelector` — Default `:` (ganzer Body ohne Frontmatter, gekürzt). Weiter erlaubt:
  `#Überschrift`, `^block-id`.
- `selectorProperty` (optional) — Notiz-Property, die `coverSelector` pro Notiz überschreibt.
  Der Gedanke aus der ursprünglichen Idee bleibt erhalten, ohne Pflicht zu werden.
  **Im Frontmatter muss der Wert in Anführungszeichen stehen** — ein nacktes `:` ist
  ungültiges YAML, ein nacktes `#` beginnt einen Kommentar. Also `cover: ":"` und
  `cover: "#Fazit"`. Ohne Quotes ist die Property leer und der View fällt auf seine
  eigene Einstellung zurück; das ist gutartig, aber unsichtbar.
- `coverSource` — `content` | `image` | `auto`. Bei `auto`: erstes Embed der Notiz als Bild,
  sonst Text. `file.embeds` liefert die Kandidaten ohne eigenen Parser.
- `maxLength` — Zeichen, Default 300.
- `renderMode` — `text` (Default) | `markdown`.
- `cardSize` — `auto` (Default, Höhe je Karte nach Inhaltsmenge) | `uniform` (alle gleich).
- `sizeProperty` (optional) — Notiz-Property, die die Kartengröße pro Notiz erzwingt
  (`s` | `m` | `l` | `xl`).
- `maxSize` — Obergrenze in Rasterstufen, damit eine lange Notiz nicht die halbe Spalte
  belegt. Default `l`. Zusätzlich `unlimited`: die Karte wächst dann, bis das ganze Cover
  hineinpasst. In der Praxis begrenzt `maxLength` (Default 300 Zeichen) die Höhe ohnehin —
  wer wirklich lange Karten will, muss beides hochsetzen.
  Der Verlauf am unteren Rand erscheint nur noch, wenn tatsächlich etwas abgeschnitten ist;
  bei `unlimited` ist das meist nicht der Fall, und verblassender vollständiger Text sähe
  nach Fehler aus.

Welche Properties unter dem Cover erscheinen und in welcher Reihenfolge, bestimmt weiter
`config.getOrder()`, also der Property-Picker der Toolbar. Dafür ist keine eigene Option
nötig.

## Architektur

Unverändert gegenüber dem Tabellen-Plan, nur der View-Teil ist kleiner:

1. **`selector.ts`** — reine Funktionen, kein Obsidian-Bezug: `parseSelector()`,
   `resolve(content, cache, selector)`. Bleibt die Stelle, die sich unverändert als
   Formel-Funktion herausreichen lässt, falls Obsidian eine Funktions-API nachliefert.
   Frontmatter über `frontmatterPosition` abschneiden, Überschriften/Blöcke über
   `metadataCache.getFileCache()` — kein eigener Markdown-Parser.
2. **`contentCache.ts`** — `Map<path, { mtime, text }>`, gefüllt per `vault.cachedRead()`,
   invalidiert über `mtime` und `vault.on('modify')`.
3. **`view.ts`** — `BasesView`. Rendert `data.groupedData`, eine Karte je `BasesEntry`,
   Gruppen als Zwischenüberschriften.
4. **`main.ts`** — Registrierung, Styles.

### Individuelle Kartenhöhe je Notiz

Jede Karte soll so hoch sein, wie ihr Inhalt es verlangt — kurze Notiz, kurze Karte. Das ist
machbar, hat aber genau einen Haken, und der bestimmt das Vorgehen.

**Der Haken:** Der Inhalt trifft verzögert ein (`cachedRead` ist async). Wer die Karte erst
rendert und dann wachsen lässt, schiebt bei jedem eintreffenden Text das halbe Layout um.
Bei 370 Notizen in `Knowledgebase.base` springt die Seite dann sekundenlang.

**Die Lösung:** Die Höhe *schätzen, bevor gelesen wird*. `file.size` ist eine eingebaute
Bases-Property und über `entry.getValue('file.size')` **synchron** verfügbar — ohne jede
Datei-I/O. Bytes → Größenstufe → die Karte belegt ihren Platz sofort, korrekt gestuft, und
der Text füllt ihn später nur noch aus.

Ablauf je Karte:

1. `file.size` lesen (synchron) → Stufe `s` / `m` / `l` / `xl` → `grid-row: span N`.
2. `sizeProperty` der Notiz überschreibt die Stufe, falls gesetzt.
3. Inhalt trifft ein → einmalig nachmessen. Weicht die tatsächliche Höhe um mehr als eine
   Stufe ab, Stufe einmal korrigieren (mit Transition), sonst clampen und gut.
4. Beim zweiten Rendern liegt der Text im Cache, ist also synchron da — dann gibt es gar
   keine Korrektur mehr.

**Einschränkungen, ehrlich:** `file.size` zählt das Frontmatter mit; bei kurzen Notizen mit
viel Frontmatter überschätzt es. Und bei `coverSelector: "#Fazit"` sagt die Dateigröße nichts
über die Abschnittslänge. In beiden Fällen greift Schritt 3 — es ruckelt einmal statt gar
nicht. Deshalb bleibt `cardSize: uniform` als Option: für dichtes Überfliegen großer Bases
ist gleich hoch ohnehin besser lesbar.

### Warum Grid-Spans und keine Spalten-Masonry

- **CSS `column-count` scheidet aus.** Multi-Column füllt Spalte 1 komplett, dann Spalte 2 —
  die Lesereihenfolge liefe von oben nach unten statt von links nach rechts. Bases liefert
  die Daten sortiert; eine nach `created DESC` sortierte Base sähe damit schlicht falsch aus.
- **Natives CSS-Masonry ist noch nicht nutzbar.** Die CSSWG hat sich auf `display: grid-lanes`
  festgelegt, Safari 26 hat es als erstes ausgeliefert; in Chromium liegt es hinter einem
  Flag, stabil erwartet im Laufe von 2026. Obsidian ist Electron/Chromium — also frühestens
  später, dann per `CSS.supports()` zuschaltbar.
- **Gewählt: `display: grid` mit `grid-auto-rows: 8px` und `grid-row: span N` je Karte.**
  Reihenfolge bleibt zeilenweise korrekt, kein JS-Layout, Resize erledigt der Browser. Preis:
  gelegentlich eine Lücke am Zeilenende, weil Karten nicht hochrutschen. Das ist der
  Unterschied zu echtem Keep — und der akzeptable Teil des Handels.
- JS-Masonry (kürzeste Spalte, absolut positioniert) wäre lückenlos, kostet aber eigene
  Layoutberechnung bei jedem Resize und weicht die Sortierreihenfolge auf. Erst, wenn die
  Lücken wirklich stören.

### Weiteres zur Performance

- Inhalt nur für sichtbare Karten lesen (`IntersectionObserver`), nicht für alle Treffer.
  Die `file.size`-Schätzung macht das erst möglich: ungelesene Karten kennen ihre Höhe
  trotzdem, also stimmen Scrollhöhe und Scrollbar von Anfang an.
- Auf `maxLength` kürzen, *bevor* gerendert wird.
- `MarkdownRenderer.render()` ist teuer — Default bleibt Klartext.
- `data` und die `BasesEntry`-Objekte werden bei jeder Änderung neu erzeugt: keine
  Referenzen halten, Cache über den Pfad schlüsseln, DOM-Knoten wiederverwenden statt
  `empty()` + Neuaufbau.

### Kleinigkeiten mit gutem Verhältnis

- `createFileForView(name, frontmatterProcessor)` (seit 1.10.2) gibt die Keep-typische
  "+"-Karte am Ende praktisch geschenkt — inklusive vorbelegtem Frontmatter.
- Klick öffnet die Notiz, Hover zeigt die Vorschau. Beides steht fertig im Beispiel unter
  <https://docs.obsidian.md/plugins/guides/bases-view>.

## Schritte

1. Plugin-Gerüst in einem **separaten Test-Vault** — nicht hier, dieser Vault hängt an
   obsidian-git mit Auto-Commit.
2. `selector.ts` + Tests, ohne Obsidian lauffähig, deshalb zuerst.
3. Minimaler View: Karten mit `file.name` und festem Cover `:`. Beweist die Async-Kette
   Ende zu Ende.
4. Properties unter dem Cover aus `config.getOrder()`, Gruppen aus `groupedData`.
5. Optionen: `coverSelector`, `selectorProperty`, `maxLength`.
6. Individuelle Kartenhöhe: `file.size`-Stufen → `grid-row: span N`, Korrektur nach dem
   Laden, `sizeProperty` als Override. Danach Lazy-Loading über `IntersectionObserver`.
7. `coverSource: auto` (Bild-Embed als Cover), `renderMode: markdown`, `layout: masonry`.
8. Gegen echte Daten: `Knowledgebase.base` (~370 Notizen) als Lastfall,
   `Databases/Meine Software` als inhaltlicher — dort sind viele Items noch leer, und ein
   leeres Cover zeigt genau das auf einen Blick.

## Risiken

- **Karten skalieren schlechter als Zeilen.** 370 Karten scrollen sich zäh und lassen sich
  schlechter vergleichen als eine Tabelle. Sortieren und Filtern bleiben über die Toolbar
  erreichbar, aber der Überblick ist ein anderer. Für große Bases bleibt die eingebaute
  Tabelle die bessere View — beide nebeneinander in derselben `.base` sind explizit
  vorgesehen.
- **API-Bewegung:** Bases ist jung (View-API seit 1.10.0, `createFileForView` erst 1.10.2).
- **Scope:** `coverSource: auto` und `masonry` sind die zwei Stellen, an denen sich das
  Projekt ausdehnen kann. Bewusst hinter Schritt 6 gelegt.
