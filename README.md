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
4. KI-Redaktion: liefert **strukturierte Felder**, keine fertigen Titel —
   `ort`, `kanton`, `titel` (deutsch), `start`, `ende`, `art`, `description`.
   Sie entfernt nach Thema, Dubletten im Block, fehlendem Ort und
   Dauerausstellungen. Letzteres ist bewusst bei der KI geblieben: ein
   fehlendes Datum heisst nicht "unbefristet", der Plateforme-10-Feed liefert
   auch zu laufenden Ausstellungen keine Laufzeit. Wer das als Skriptregel
   nachbaut, wirft echte Ausstellungen weg - am 25.08. waren es 12.
5. Regelfilter im Skript: Datum, Reisezeit, Dauerausstellung, Dubletten.
   Alles Rechenbare gehört hierher, nicht in den Prompt — es gilt dann auch
   für Einträge aus dem Cache.
6. Titel bauen, RSS schreiben, zusammen mit Log und Cache nach GitHub hochladen.

## Stellschrauben (oben in `Code.js`)

| Konstante | Bedeutung |
|---|---|
| `MAX_REISEZEIT_MIN` | Wie weit weg darf es sein (ÖV-Minuten ab Morges). Zurzeit 120. |
| `AUSNAHME_ORTE` | Orte, die trotz längerer Anreise drinbleiben. Zurzeit Zürich und Bern. |
| `REISEZEIT_ORT` / `REISEZEIT_KANTON` | Die Reisezeit-Tabelle. Unbekannter Ort → Kanton entscheidet. |
| `GROSSE_ORTE` | Orte ohne Kantonskürzel im Titel. Alle anderen: `[Cheseaux-Noréaz VD]`. |
| `MAX_LAUFZEIT_TAGE` | Ab welcher Restlaufzeit etwas als Dauerausstellung gilt. |
| `AI_CHUNK_SIZE` | Einträge pro KI-Aufruf. **Nicht erhöhen** — siehe unten. |
| `AI_BUDGET_MS` | Wann das Skript aufhört, die KI zu fragen. |
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
