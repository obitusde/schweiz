# Veranstaltungs-Aggregator

Baut aus mehreren Quellen einen gefilterten Veranstaltungsfeed und legt das
Ergebnis in diesem Repo ab, das über GitHub Pages ausgeliefert wird.

- Feed: `https://obitusde.github.io/schweiz/veranstaltungen.xml`
- Apps-Script-Projekt: `1U_wyFoMvoVGT656WzbdrwFYceYvWARKqfa4vpZeihPpQdHUFIgwGLas6`
- Konfiguration: Tabelle `1IoqQHHzIOOBniYcOYGfYoITzk96K-_ommHSl8m0C4HA`, Tab **Veranstaltungen**
- Läuft täglich um 06:00 (`createTrigger()`)

## Dateien im Repo

| Datei | Wer schreibt sie | Wozu |
|---|---|---|
| `Code.js` | von Hand, per `clasp push` | der Aggregator selbst |
| `veranstaltungen.xml` | das Skript | der Feed |
| `veranstaltungen.log` | das Skript | was in einem Lauf warum passiert ist |
| `veranstaltungen-cache.json` | das Skript | KI-Ergebnisse pro Link, damit nicht jeder Lauf alles neu analysiert |
| `morges-events.xml` | niemand mehr | Rest eines Experiments vom 14.06.2026, wird nicht gelesen |

## Ablauf eines Laufs

1. Quellen aus der Tabelle lesen, Feeds holen.
2. Keyword-Filter (Spalte C der Tabelle).
3. Cache-Abgleich: was schon analysiert wurde, wird nicht erneut an die KI gegeben.
4. KI-Redaktion in **zwei Durchgängen**: erst alle Blöcke, dann eine zweite
   Runde für Einträge, zu denen nichts zurückkam — das kleine Modell überspringt
   gelegentlich einzelne Artikel. Sie liefert **strukturierte Felder**, keine
   fertigen Titel: `ort`, `kanton`, `titel` (deutsch), `start`, `ende`, `art`,
   `description`.
   Sie entfernt nach Thema, Dubletten im Block, fehlendem Ort und
   Dauerausstellungen. Letzteres ist bewusst bei der KI geblieben: ein
   fehlendes Datum heisst nicht "unbefristet", der Plateforme-10-Feed liefert
   auch zu laufenden Ausstellungen keine Laufzeit. Wer das als Skriptregel
   nachbaut, wirft echte Ausstellungen weg - am 25.08. waren es 12.
5. Regelfilter im Skript: Datum, Reisezeit, Dauerausstellung, Dubletten.
   Alles Rechenbare gehört hierher, nicht in den Prompt — es gilt dann auch
   für Einträge aus dem Cache.
6. Titel bauen (`[Ort] [Gattung] Titel - Datum`), RSS schreiben, zusammen mit Log und Cache nach GitHub hochladen.

## Stellschrauben (oben in `Code.js`)

| Konstante | Bedeutung |
|---|---|
| `MAX_REISEZEIT_MIN` | Wie weit weg darf es sein (ÖV-Minuten ab Morges). Zurzeit 120. |
| `AUSNAHME_ORTE` | Orte, die trotz längerer Anreise drinbleiben. Zurzeit Zürich und Bern. |
| `REISEZEIT_ORT` / `REISEZEIT_KANTON` | Die Reisezeit-Tabelle. Unbekannter Ort → Kanton entscheidet. |
| `GROSSE_ORTE` | Orte ohne Kantonskürzel im Titel. Alle anderen: `[Cheseaux-Noréaz VD]`. |
| `RANG_SCHWELLEN` | Welcher Bedeutungsrang bei welcher Reisezeit noch reicht. |
| `ANKER_HAEUSER` | Häuser, die immer als überregional gelten. Dein Hebel, wenn etwas fehlt. |
| `VORSCHAU_TAGE` | Wie weit voraus der Feed schaut. Betrifft nur den Beginn — Laufendes bleibt. |
| `MAX_LAUFZEIT_TAGE` | Ab welcher Restlaufzeit etwas als Dauerausstellung gilt. |
| `AI_CHUNK_SIZE` | Einträge pro KI-Aufruf. **Nicht erhöhen** — siehe unten. |
| `AI_BUDGET_MS` | Wann das Skript aufhört, die KI zu fragen. |
| `SCRAPE_MAX_LINKS` | Höchstzahl Links, die eine scrape-Quelle beisteuern darf. |
| `CACHE_VERSION` | Hochzählen, wenn sich das Cache-Format ändert. Erzwingt eine Neuanalyse. |

## Zwei Zeitgrenzen, die alles bestimmen

**`UrlFetchApp` bricht nach rund 60 Sekunden ab** und gibt den bis dahin
empfangenen Text zurück — *ohne* einen Fehler zu werfen. Eine zu große
Blockgröße führt deshalb nicht zu einer Fehlermeldung, sondern zu
abgeschnittenem JSON. Bei 12 Einträgen pro Block trat das reihenweise auf, bei
6 nicht mehr. `sammleObjekte()` rettet aus einer angeschnittenen Antwort die
vollständigen Objekte, damit ein Block nicht komplett verloren geht.

**Apps Script beendet eine Ausführung nach 6 Minuten.** Mehr Blöcke heißt
längere Laufzeit, deshalb hört die Schleife nach `AI_BUDGET_MS` von selbst auf.
Die übrigen Einträge stehen dann eine Runde unformatiert im Feed und werden
beim nächsten Lauf nachgeholt — ohne KI-Antwort entsteht kein Cache-Eintrag.

## Je weiter weg, desto mehr muss es hergeben

Der Feed soll nicht alles zeigen, sondern was sich lohnt — und vor der Haustür
lohnt sich mehr als in Zürich. Deshalb liefert die KI je Eintrag einen
**Rang** (1 = überregional, 2 = solide regional, 3 = klein/lokal), und das
Skript entscheidet anhand der Reisezeit, was reicht:

| Reisezeit ab Morges | verlangt |
|---|---|
| bis 30 min (Morges, Lausanne, Nyon, Prangins) | jeder Rang |
| bis 60 min (Genf, Yverdon, Vevey) | Rang 1–2 |
| darüber (Bern, Thun, Sierre, Zürich) | nur Rang 1 |

Eine Van-Gogh-Retrospektive in Zürich kommt also durch, die Ortsmuseums-Vitrine
in Bern nicht — eine kleine Ausstellung in Morges dagegen schon.

`ANKER_HAEUSER` überschreibt das Urteil der KI für Häuser von nationalem Rang.
Fehlt dir etwas aus einer Stadt, ist das die Stelle: Hausnamen eintragen,
klein geschrieben. Fehlt der Rang in der KI-Antwort, wird 2 angenommen und das
im Protokoll vermerkt — steht dort oft „von der KI nicht gesetzt", stimmt etwas
mit dem Prompt nicht.

## Der Ort darf nie geraten werden

Der Prompt hat lange erlaubt, den Ort aus dem **Feed-Namen** abzuleiten. Das
ging gut, solange jede Quelle für genau einen Ort stand. Mit `Vaud.de Morges`
— einer Quelle für die ganze Region — schrieb die KI dann `Morges` an
Veranstaltungen, die anderswo stattfanden, und sogar in deren Beschreibung
hinein. Seither gilt: Ort nur aus dem Text des Eintrags oder aus Weltwissen
über ein **namentlich genanntes Haus**. Sonst fliegt der Eintrag raus.

Das kostet Einträge bei Regionsquellen, und das ist Absicht: ein falscher Ort
ist schlimmer als ein fehlender Eintrag, weil der Entfernungsfilter auf dem
Ort aufbaut.

## Grundregel: ein Ausfall darf den Feed nicht leeren

Am 25.08.2026 stand kurzzeitig ein leerer Feed online. Drei Sicherungen
verhindern das jetzt, jede für sich hätte gereicht:

1. Angeschnittene KI-Antworten werden ausgewertet, statt den Block zu verwerfen.
2. Einträge ohne KI-Daten bleiben **unverändert** im Feed statt gelöscht zu werden.
3. Bei 0 Einträgen wird gar nicht hochgeladen; die bisherige Datei bleibt stehen.

Wer hier etwas ändert, sollte alle drei erhalten.

## Eine Quelle hinzufügen

Quellen kommen über den **Website-Watcher**
(`obitusde/website-watcher`, exec-URL `AKfycbwiTrliLNmT…`), der aus einer
beliebigen Webseite einen RSS-Feed macht. Der Aggregator liest davon
`?quelle=<Name>`.

1. Im Watcher eine Zeile in der Quellen-Tabelle anlegen: Name, Gruppe, URL,
   Typ `web`, Link-Filter. Muster mit `zeigeAlleLinks()` ermitteln, mit
   `testeZeile()` gegenprüfen.
2. Hier im Tab **Veranstaltungen**: Spalte A die `?quelle=…`-URL,
   Spalte B der Anzeigename, **Spalte F leer lassen**.

### Dritte Alternative: Wochenrückblick-Artikel

Manche Seiten haben keine Einzelseite pro Termin, sondern veröffentlichen
**einen Artikel pro Woche** mit mehreren Tipps in Prosa (Beispiel:
`thelausanneguide.com/category/events` — jede Woche ein neuer Artikel wie
„August 31 – September 6, 2026" mit acht Empfehlungen als Liste, jede in der
Form `Titel (Wochentag[-Wochentag][, Ort]): Beschreibung`).

| Spalte | Inhalt |
|---|---|
| A | URL der **Kategorieseite** (nicht der Artikel selbst — der wechselt wöchentlich) |
| B | Anzeigename |
| F | `digest` |

Der Ablauf: Kategorieseite holen → ersten `/article/…`-Link nehmen (steht dort
zuoberst) → Artikel holen → Wochendatum aus `<title>`/`<h1>` lesen (Muster
„Monat Tag – [Monat] Tag, Jahr") → jeden `<li>`/`<p>`-Block gegen
`Titel (Tag[e][, Ort]): Text` prüfen. Datum und Ort werden **deterministisch**
aus dem Wochentag berechnet und explizit in die Beschreibung geschrieben
(„Termin: 31.08.2026. Ort: Lutry.") — die KI-Redaktion liest sie danach nur
noch ab, statt sie zu schätzen. Erst dieser fertige Text durchläuft die
normale Redaktion (Übersetzung, Rang, Gattung) und den Regelfilter.

Bricht die Erkennung irgendwo ab (kein Artikel-Link, kein Wochendatum im
Titel, kein Listen-Block passt), liefert die Quelle für diesen Lauf 0
Einträge und das Protokoll nennt den Grund (`[DIGEST] ... kein ...`) — kein
Absturz, kein falsches Datum.

### Alternative: direkt scrapen

Statt über den Watcher kann eine Seite auch direkt geholt und per KI
ausgewertet werden — dann steht in Spalte A die echte Seiten-URL:

| Spalte | Inhalt |
|---|---|
| A | URL der Übersichtsseite |
| B | Anzeigename |
| F | `scrape` |
| G | Link-Muster: Teilstring (`event-details`) oder `/regex/`. Leer = `event-details` |

Das Muster entscheidet, welche Links auf der Seite Veranstaltungen sind. Es
findet sich, indem man die Seite öffnet und die URL eines einzelnen Events mit
der einer Übersichts- oder Navigationsseite vergleicht — gesucht ist das, was
nur die Event-Links haben.

Wann welcher Weg? Der Watcher ist billiger (kein KI-Aufruf) und liefert
saubere Titel, wenn die Seite ordentliche Linktexte hat. Scrape kostet einen
KI-Aufruf je 40 Einträge (Ergebnis 6 h zwischengespeichert), kommt dafür auch
mit nichtssagenden Linktexten zurecht, weil das Modell den umgebenden Text
liest. Beide scheitern an Seiten, die ihre Liste erst im Browser aufbauen —
dann steht im Protokoll `kein Link passt auf ...`.

## Entwicklung

```bash
clasp pull            # Serverstand holen, bevor man etwas ändert
clasp push -f         # hochladen
```

`clasp run` funktioniert **nicht** — das Projekt hängt am Standard-Cloud-Projekt
und ist nicht als API-Executable deployt. Ausgeführt wird im Editor oder vom
Trigger. Das Ergebnis lässt sich aber ohne Editor prüfen: `veranstaltungen.log`
in diesem Repo enthält für jeden Lauf, was mit welcher Begründung entfernt wurde.
