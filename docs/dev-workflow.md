# Dev-Workflow für das Plugin

Gilt für `bases-content-cards`. Plan: [plan-content-cards.md](plan-content-cards.md),
API-Fakten: [bases-api.md](bases-api.md).

Lokal vorhanden: Node v24.18.1, npm 11.16.0, Obsidian 1.13.4. Das npm-Paket `obsidian`
steht bei 1.13.1 — die Bases-Typen (`@since 1.10.0`) sind darin enthalten.

## Grundsatz: getrennter Dev-Vault

Die Doku ist an der Stelle ungewöhnlich deutlich:

> "one mistake can lead to unintended changes to your vault. To prevent data loss, you
> should never develop plugins in your main vault."

Hier gilt das doppelt: `Obsidian Vault` hängt an obsidian-git mit Auto-Commit. Ein Plugin,
das beim Testen Dateien anfasst, schreibt das ungefragt in die Historie.

Also ein zweiter Vault, z. B. `~/Git/obsidian-dev-vault/`.

## Aufbau

```
~/Git/obsidian-bases-content-cards/        ← das Git-Repo
├── src/
│   ├── main.ts            Registrierung, Settings
│   ├── view.ts            der BasesView
│   ├── selector.ts        reine Funktionen, kein Obsidian-Import
│   └── contentCache.ts    cachedRead + mtime-Invalidierung
├── tests/selector.test.ts
├── styles.css
├── manifest.json
├── versions.json
├── esbuild.config.mjs
├── tsconfig.json
└── package.json

~/Git/obsidian-dev-vault/.obsidian/plugins/
└── bases-content-cards -> ~/Git/obsidian-bases-content-cards   (Symlink)
```

Das Repo liegt bei den anderen Projekten in `~/Git/`, nicht im Vault vergraben. Obsidian
folgt dem Symlink problemlos.

## Einrichtung

```sh
# 1. Repo aus der offiziellen Vorlage (GitHub-Template "Use this template",
#    oder direkt klonen und die Historie wegwerfen)
git clone https://github.com/obsidianmd/obsidian-sample-plugin \
    ~/Git/obsidian-bases-content-cards
cd ~/Git/obsidian-bases-content-cards
rm -rf .git && git init
npm install
npm install obsidian@latest --save-dev

# 2. Dev-Vault anlegen (leerer Ordner, in Obsidian einmal öffnen)
mkdir -p ~/Git/obsidian-dev-vault/.obsidian/plugins

# 3. Symlink statt Kopieren
ln -s ~/Git/obsidian-bases-content-cards \
      ~/Git/obsidian-dev-vault/.obsidian/plugins/bases-content-cards

# 4. Hot-Reload danebenlegen
git clone https://github.com/pjeby/hot-reload \
    ~/Git/obsidian-dev-vault/.obsidian/plugins/hot-reload
```

`manifest.json` anpassen: `id: bases-content-cards`, `isDesktopOnly: false` und
`minAppVersion: "1.10.2"` — `createFileForView` gibt es erst ab 1.10.2, ohne diese Funktion
reicht `1.10.0`.

Beide Plugins in den Community-Plugin-Einstellungen des Dev-Vaults aktivieren.

## Die Schleife

```sh
npm run dev     # esbuild im Watch-Modus, src/main.ts -> main.js
```

Speichern → esbuild baut neu → hot-reload sieht die geänderte `main.js` und schaltet das
Plugin nach ca. 0,75 s aus und wieder ein. Kein Neustart, kein Klicken in den Einstellungen.

Hot-reload erkennt zu überwachende Plugins an einem `.git`-Ordner **oder** einer Datei
`.hotreload` im Plugin-Verzeichnis. Über den Symlink ist `.git` sichtbar, es sollte also von
allein greifen; falls nicht, `touch .hotreload` im Repo (und in `.gitignore` eintragen).

Zwei Dinge, die die Schleife durchbrechen:

- **Änderungen an `manifest.json`** greifen erst nach einem Obsidian-Neustart.
- **Ein bereits offener View des eigenen Typs** hält nach dem Reload womöglich noch die alte
  Klasse. Im Zweifel in der `.base` einmal auf einen anderen View und zurück schalten.
  Voraussetzung dafür, dass Hot-Reload überhaupt sauber funktioniert, ist ein ordentliches
  `onunload()` — die `register*()`-Methoden von `Plugin` räumen selbst auf, alles andere
  nicht.

Devtools mit `Cmd+Alt+I`. esbuild schreibt im Dev-Build inline Sourcemaps, Breakpoints
landen also in `.ts`.

## Testdaten im Dev-Vault

```sh
node scripts/seed-dev-vault.mjs                              # 120 Notizen + Dev.base
node scripts/seed-dev-vault.mjs ~/Git/obsidian-dev-vault 600 # Lastfall
```

Bewusst **synthetisch statt kopiert**. Was hier zählt, ist die Streuung der Notizlängen —
daran entscheidet sich, ob die `file.size`-Schätzung trägt. Das Skript erzeugt leere
Notizen, Einzeiler, mittlere und lange, dazu `## Fazit`-Abschnitte und Block-IDs, damit sich
alle Selektoren durchprobieren lassen. Eine leere Karte soll leer aussehen, nicht kaputt.

Falls doch echte Notizen: immer eine **Kopie** eines Ausschnitts, nie ein Symlink auf den
Produktivvault. Sonst schreibt ein Fehler im Plugin in den Vault, der auto-committet wird.

## Testen ohne Obsidian

`selector.ts` importiert nichts aus `obsidian` — Selektoren parsen, Frontmatter abschneiden,
Abschnitt herausschneiden. Das ist die Logik mit den meisten Sonderfällen und läuft in
`node --test` bzw. Vitest ohne Obsidian.

Die Faustregel für den Alltag: **Sonderfälle im Test, Optik im Dev-Vault.** Wer
Selektor-Randfälle im laufenden Obsidian durchprobiert, verliert die meiste Zeit.

Was Tests brauchen: `CachedMetadata`-Fixtures (`frontmatterPosition`, `headings[]`,
`sections[]`) — die kann man aus der Devtools-Konsole des Dev-Vaults abgreifen
(`app.metadataCache.getFileCache(app.workspace.getActiveFile())`) und als JSON ablegen.

## Veröffentlichen

1. `npm version patch|minor` — das mitgelieferte `version-bump.mjs` schreibt die neue Version
   in `manifest.json` und trägt sie samt `minAppVersion` in `versions.json` nach.
2. Tag pushen. Ein GitHub-Actions-Workflow (im Template enthalten) baut und hängt
   `main.js`, `manifest.json` und `styles.css` an das Release.
3. **Im echten Vault installieren über BRAT**, nicht per Symlink. Der Produktivvault soll
   nur fertige Releases sehen — sonst hängt er an einem halbfertigen Build.
4. Erst wenn es sich bewährt: PR gegen `obsidianmd/obsidian-releases` für den
   Community-Katalog.

## Reihenfolge der ersten Sitzungen

1. Setup wie oben, Plugin registriert einen leeren View, der "hello" rendert. Beweist die
   ganze Kette inklusive Hot-Reload.
2. `selector.ts` + Tests. Ohne Obsidian, deshalb schnell.
3. Karten mit `file.name` + Cover `:` — die erste echte Ansicht.

Ab hier gilt der Plan in [plan-content-cards.md](plan-content-cards.md).
