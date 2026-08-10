# Projektidee: Bases erweitern — Bewertung

Ausgangspunkt: eine QuickCapture-Notiz im Vault (`QuickCapture/2026-08-10 00.42.13.md`,
festgehalten am 2026-08-10). Zwei Ideen, beide betreffen Bases.
Faktenbasis und Quellen: [bases-api.md](bases-api.md). Implementierungsplan zur empfohlenen
Variante: [plan-content-cards.md](plan-content-cards.md). Repo-Aufbau und Arbeitsablauf:
[dev-workflow.md](dev-workflow.md).

**Kurzfassung:** Idee A ist machbar, aber nicht auf dem Weg, den die Notiz skizziert — eine
Spalte in die *eingebaute* Tabelle einzuhängen ist nicht vorgesehen. Idee B zerfällt in zwei
Hälften: "Bases mit CSV/JSON als Backend" ist unmöglich, "Bases-Ergebnis automatisch nach
JSONL/CSV schreiben" ist möglich, aber zu 90 % bereits eingebaut.

---

## Idee A — Notizinhalt als Spalte

> Man gibt wie bei Bildern `:` oder `12:20` in eine Property an, und der Inhalt wird in die
> Spalte geladen.

**Möglich: ja. So wie beschrieben: nein.**

Drei Dinge stehen dem wörtlichen Entwurf im Weg:

1. **Es gibt keinen Weg, eine Spalte zur eingebauten Tabelle hinzuzufügen.** Die Plugin-API
   kennt für Bases genau einen Einstieg — `registerBasesView()`, also einen *kompletten
   eigenen View-Typ*. Keine virtuellen Properties, keine eigenen Formel-Funktionen.
   Wer eine Inhaltsspalte will, liefert die Tabelle mit, in der sie steht.
2. **Bases kann Notizinhalt grundsätzlich nicht sehen.** Es gibt kein `file.content`. Der
   Body muss vom Plugin selbst per `vault.cachedRead()` geholt werden — und das ist
   asynchron, während `getValue()` und `onDataUpdated()` synchron sind. Das ist kein
   Blocker, aber es bestimmt die Architektur (Cache + Nachrendern).
3. **Zeilennummern sind eine brüchige Adresse.** `12:20` zeigt nach der nächsten
   Absatzeinfügung auf etwas anderes — still und ohne Fehlermeldung. Obsidian hat mit
   `#Überschrift` und `^block-id` bereits stabile Adressen für genau dieses Problem.

Es gibt außerdem Vorarbeit: [obsidian-bases-preview](https://github.com/codybontecou/obsidian-bases-preview)
macht faktisch Idee A, per MutationObserver und DOM-Injektion in die gerenderte Tabelle. Das
funktioniert, hängt aber am internen HTML-Aufbau von Bases und übersteht Re-Renders nur mit
Klimmzügen. Als Beleg, dass der Bedarf real ist, ist das Plugin wertvoll; als Bauplan nicht.

### Was daraus geworden ist: Karte statt Spalte

Erster Entwurf war ein eigener Tabellen-View mit zusätzlichen Inhaltsspalten. Der Aufwand
lag dabei fast vollständig im *Nachbauen der Tabelle* — Kopfzeile, Spaltenbreiten, ein
Zellen-Renderer je `Value`-Typ — und nicht in dem, worum es geht.

Der bessere Zuschnitt (Marcels Vorschlag): ein **Card-View wie Google Keep / Notion**, bei
dem der Notizinhalt das **Cover** bildet — dort, wo der eingebaute Cards-View ein Bild aus
einer Property zeigt. Properties darunter. Das ist dieselbe Idee, nur in der Form, die zu
ihr passt:

- Der Nutzen von A ist *Inhalt sehen*, nicht das Tabellenraster. Eine Karte zeigt drei Zeilen
  Fließtext lesbar, eine Tabellenzelle nicht.
- **Read-only ist kein Kompromiss mehr, sondern erwartetes Verhalten** — bei einer Karte will
  niemand in der Zelle tippen, Klick öffnet die Notiz. Damit fällt die riskanteste Stelle des
  ganzen Projekts (Zurückschreiben in einen Zeilenbereich) ersatzlos weg.
- **Zeilenbereiche (`12:20`) werden überflüssig.** Für ein Cover will man "Anfang der Notiz"
  oder "Abschnitt *Fazit*" — `:` und `#Überschrift` decken das ab, und beide überleben das
  Editieren. Die brüchigste Idee aus dem Entwurf entfällt, ohne dass etwas fehlt.
- Aus N konfigurierbaren Inhaltsspalten wird **ein** Cover-Selektor. Die Per-Notiz-Property
  bleibt als *Override* erhalten, wird aber nicht Pflicht — eine Regel für die ganze View
  will man nicht in 120 Notizen einzeln pflegen.
- Welche Properties unter dem Cover stehen, liefert weiter `config.getOrder()`, also der
  Property-Picker der Bases-Toolbar. Filter, Sortierung und Gruppierung ebenso.

Jede Karte ist dabei so hoch, wie ihr Inhalt es verlangt. Der ernstzunehmende Fallstrick
daran ist das Zusammenspiel mit dem asynchronen Lesen: variable Höhen plus nachtröpfelnder
Text lassen das Layout springen. Gelöst über `file.size` — eine eingebaute Bases-Property,
synchron und ohne Datei-I/O verfügbar, aus der sich die Kartenhöhe *vor* dem Lesen stufen
lässt. Details und Reihenfolge: [plan-content-cards.md](plan-content-cards.md).

---

## Idee B — Bases mit JSON/CSV-Backend

Die Notiz vermischt zwei Richtungen, die sehr unterschiedlich ausgehen.

### B1: CSV/JSONL *als Datenquelle* für Bases — nicht möglich

Es gibt keinen Data-Source-Hook. Bases fragt immer die Dateien im Vault ab; ein eigener View
darf das Ergebnis *darstellen*, aber nicht bestimmen, woraus es besteht. Eine JSONL-Datei
kann keine Zeilen in eine Base einspeisen.

Der einzige Weg dorthin wäre umgedreht: CSV als Wahrheit, und ein Sync-Skript erzeugt pro
Zeile eine Notiz. Das ist bei ~9 Sammlungen in `Databases/` technisch machbar, kostet aber
genau das, was den Vault ausmacht — freier Text unter dem Frontmatter, Links, Editieren in
Obsidian. Ich würde davon abraten.

### B2: Jeder Bases-Eintrag wird automatisch eine Zeile in JSONL/CSV — möglich, aber größtenteils vorhanden

Bases exportiert bereits: pro View gibt es *Copy to clipboard* und *CSV export*. Was fehlt,
ist ausschließlich das **automatische** Schreiben bei jeder Änderung. Dafür gibt es zwei
Wege:

- **Im Plugin:** ein View-Typ, dessen `onDataUpdated()` das Ergebnis wegschreibt. Vorteil:
  die echte Query-Engine samt Filtern und Formeln wird mitbenutzt. Zu beachten: schreiben in
  den Vault löst Metadaten-Events aus — Ziel außerhalb der Query halten (`.jsonl` fällt
  ohnehin aus `file.ext == "md"` heraus) und entprellen, sonst dreht sich das im Kreis.
- **Ohne Plugin:** ein Skript, das Frontmatter über den Vault einsammelt und JSONL schreibt,
  angehängt an einen Git-Hook oder den bestehenden Backup-Lauf. Passt zu dem, was in
  `.agents/tools/` schon steht. Preis: die `.base`-Filter und -Formeln müssten nachgebaut
  werden — die Query-Sprache bekommt man von außen nicht geschenkt.

Beide sind kleine Projekte. Nur: **wofür?** Solange der Abnehmer nicht feststeht (SQL-Abfragen
über den Vault, Auswertung, Export in ein anderes Tool, Backup), lässt sich weder Format noch
Auslösezeitpunkt sinnvoll festlegen. Für "SQL über den Vault" gibt es mit SQLSeal bereits ein
Plugin — das wäre dann gar kein Eigenbau.

---

## Empfehlung

1. **Idee A bauen**, als eigenen Card-View mit Inhalt als Cover, read-only, mit
   Heading-/Block-Adressierung. Das ist die Idee mit echtem Alltagsnutzen — die
   `Knowledgebase.base` und die `Databases/*`-Views zeigen heute Dateinamen und Tags, aber
   nie einen Satz aus der Notiz. Die Tabelle bleibt daneben bestehen; mehrere Views in
   derselben `.base` sind vorgesehen.
2. **Idee B nicht im selben Projekt.** Sie teilt mit A weder Code noch Nutzen. Vorher klären,
   wer die JSONL liest; danach ist es vermutlich ein 100-Zeilen-Skript und kein Plugin.
3. **Parallel den eigentlichen Hebel anstoßen:** Wenn Obsidian eine Funktions-API für Bases
   nachliefert (Forum-Thread existiert, umgesetzt ist nichts), wird A zu einer Handvoll
   Zeilen — `content(":")` als Formel, nutzbar in *jedem* View inklusive der eingebauten
   Tabelle. Deshalb im Plan: die Auflöse-Logik als eigenständiges Modul ohne View-Bezug,
   damit sie sich später unverändert als Formel-Funktion herausreichen lässt.

## Offen

- Was soll die JSONL/CSV aus B2 füttern? Ohne Abnehmer kein sinnvoller Zuschnitt.
- Cover bei Notizen, die mit einem Bild beginnen: Text oder Bild? Als Option `coverSource:
  auto` im Plan hinterlegt, aber hinter die Grundfunktion gelegt.
