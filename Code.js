// =============================================================================
// Veranstaltungen RSS Feed Aggregator
// Script Properties: GEMINI_API_KEY, GITHUB_TOKEN, OPENROUTER_KEY (optional)
// =============================================================================
//
//   Quellen mit "scrape" in Spalte F werden NICHT als RSS gelesen, sondern die
//   Webseite wird direkt geholt und per KI in Veranstaltungen umgewandelt
//   (fuer Seiten wie museen-bern.ch, die ueber PolitePaul nicht gehen).
//   Spalte F leer = normales RSS. Die Extraktion nutzt OpenRouter, falls
//   OPENROUTER_KEY gesetzt ist, sonst Gemini direkt.
//
//   ARBEITSTEILUNG KI / SKRIPT
//   Die KI liefert nur noch STRUKTURIERTE FELDER (ort, kanton, titel, start,
//   ende, art, description) und entscheidet nichts, was sich rechnen laesst.
//   Datum, Entfernung und Dauerausstellungen filtert das Skript - deterministisch
//   und auch fuer Eintraege, die aus dem Cache kommen. Vorher lief der
//   Datumsfilter nur ueber frisch geholte Artikel, deshalb standen abgelaufene
//   Cache-Eintraege weiter im Feed.
//
// =============================================================================

const ENABLE_DETAILED_LOGGING = true;
// Rueckfallebene, wenn kein OPENROUTER_KEY gesetzt ist. Flash-Lite statt Flash:
// die Aufgabe ist Datenextraktion, nicht Nachdenken - und ein Modell mit
// Denkschritten wuerde die 60-Sekunden-Grenze von UrlFetchApp schneller reissen.
const GEMINI_MODEL            = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT         = "https://generativelanguage.googleapis.com/v1beta/models/";
const OPENROUTER_ENDPOINT     = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL        = "google/gemini-3.5-flash-lite"; // gleiche Generation wie der Rueckfallpfad
const GITHUB_API_BASE         = "https://api.github.com/repos/";
const SPREADSHEET_ID          = "1IoqQHHzIOOBniYcOYGfYoITzk96K-_ommHSl8m0C4HA";
const SHEET_NAME              = "Veranstaltungen";
// UrlFetchApp kappt einen Abruf nach rund 60 Sekunden und liefert dann den
// bis dahin empfangenen Text zurueck - nicht etwa einen Fehler. Deshalb ist
// die Blockgroesse die entscheidende Stellschraube: 12 Eintraege brauchten
// ~58 s und wurden reihenweise abgeschnitten, 6 bleiben klar darunter.
const AI_CHUNK_SIZE           = 6;
const AI_MAX_TOKENS           = 16384;
// Apps Script beendet eine Ausfuehrung nach 6 Minuten. Kurz davor hoert das
// Skript von sich aus auf, die KI zu fragen: die uebrigen Eintraege stehen
// dann eine Runde lang unformatiert im Feed und werden beim naechsten Lauf
// nachgeholt, weil sie nicht im Cache landen.
const AI_BUDGET_MS            = 4.5 * 60 * 1000;
// Obergrenze fuer eine scrape-Quelle. Ein Agenda wie geneve.com listet ueber
// 500 Veranstaltungen auf Monate voraus - das waeren allein zum Auslesen
// 15 KI-Aufrufe und danach rund 100 Redaktionsbloecke. Lieber die naechsten
// Termine sauber als alles gar nicht.
const SCRAPE_MAX_LINKS        = 60;
const CACHE_TTL_DAYS          = 30;
const FETCH_DEADLINE          = 55;   // Sekunden, maximaler Apps Script Timeout

// --- Stellschrauben fuer die Auswahl -----------------------------------------
// Reisezeit ab Morges mit OeV in Minuten. 120 = alles, was in zwei Stunden
// erreichbar ist.
const MAX_REISEZEIT_MIN   = 120;
// Orte, die trotz laengerer Anreise drinbleiben, weil dort trotzdem hingefahren
// wird. Steht ein Ort hier, spielt seine Reisezeit keine Rolle.
const AUSNAHME_ORTE = { "zürich": 1, "zurich": 1, "bern": 1 };
// Laeuft eine Ausstellung laenger als das, ist es faktisch eine Dauerausstellung.
const MAX_LAUFZEIT_TAGE   = 365;
// "bis 31.12." ist der uebliche Platzhalter fuer "unbefristet" - ab dieser
// Restlaufzeit wird er als Dauerausstellung gewertet.
const JAHRESENDE_MIN_TAGE = 92;
// Je weiter die Anreise, desto mehr muss der Anlass hergeben. Vor der Haustuer
// zaehlt alles, in Zuerich nur noch das Grosse. Die KI liefert den Rang
// (1 = ueberregional, 2 = solide regional, 3 = klein), das Skript entscheidet,
// was an diesem Ort reicht.
const RANG_SCHWELLEN = [
  { bisMinuten:       30, maxRang: 3 },   // Morges, Lausanne, Nyon, Prangins
  { bisMinuten:       60, maxRang: 2 },   // Genf, Yverdon, Vevey, Montreux
  { bisMinuten: Infinity, maxRang: 1 }    // Bern, Thun, Sierre, Zuerich
];

// Haeuser, die immer als ueberregional gelten, egal wie die KI den einzelnen
// Anlass einschaetzt. Der Hebel, wenn dir aus einer Stadt etwas fehlt:
// Hausnamen hier eintragen, klein geschrieben.
const ANKER_HAEUSER = [
  "kunstmuseum bern", "zentrum paul klee", "historisches museum bern",
  "landesmuseum", "nationalmuseum", "musee national", "mus\u00e9e national",
  "kunsthaus z\u00fcrich", "kunsthaus zurich", "kunsthalle z\u00fcrich",
  "museum rietberg", "v\u00f6lkerkundemuseum", "voelkerkundemuseum",
  "musee d'ethnographie", "mus\u00e9e d'ethnographie",
  "musee d'art et d'histoire", "mus\u00e9e d'art et d'histoire",
  "musee ariana", "mus\u00e9e ariana", "maison tavel",
  "photo elysee", "photo elys\u00e9e", "mudac", "mcba", "plateforme 10",
  "fondation beyeler", "kunstmuseum thun",
  "chateau de prangins", "ch\u00e2teau de prangins"
];

// Wie weit voraus soll der Feed schauen? Faengt erst in ferner Zukunft an,
// fliegt es raus - ein Konzert im Maerz hilft heute niemandem. Betrifft nur
// den BEGINN: was jetzt schon laeuft, bleibt drin, auch wenn es lange geht.
const VORSCHAU_TAGE       = 28;
// Kurze Spannen bis zu so vielen Tagen werden als "27.-29.08." geschrieben.
const SPANNE_MAX_TAGE     = 7;
// Aendert sich das Cache-Format, muessen alte Eintraege einmal neu durch die KI.
const CACHE_VERSION       = 8;

// Der Prompt listet die Gattungen ohne Umlaute auf, damit die Antwort robust
// bleibt. Fuer den Titel werden sie hier zurueckuebersetzt.
const ART_ANZEIGE = {
  "fuehrung": "F\u00fchrung", "fuhrung": "F\u00fchrung",
  "vortrag":  "Vortrag",  "lesung":  "Lesung",  "konzert": "Konzert",
  "festival": "Festival", "theater": "Theater", "kino":    "Kino",
  "markt":    "Markt",    "sport":   "Sport",   "familie": "Familie",
  "ausstellung": "Ausstellung"
};

const MS_PRO_TAG = 24 * 60 * 60 * 1000;
const WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Orte, bei denen niemand nach dem Kanton fragt - alle anderen bekommen das
// Kantonskuerzel hinter den Namen: [Cheseaux-Noreaz VD].
const GROSSE_ORTE = {
  "lausanne": 1, "genf": 1, "geneve": 1, "genève": 1, "bern": 1,
  "zürich": 1, "zurich": 1, "basel": 1, "luzern": 1, "winterthur": 1,
  "st. gallen": 1, "lugano": 1, "biel": 1, "thun": 1, "morges": 1, "nyon": 1,
  "vevey": 1, "montreux": 1, "sion": 1, "freiburg": 1, "fribourg": 1,
  "neuenburg": 1, "neuchâtel": 1, "neuchatel": 1, "chur": 1,
  "yverdon-les-bains": 1
};

// OeV-Reisezeit ab Morges in Minuten, Richtwerte. Ort schlaegt Kanton.
const REISEZEIT_ORT = {
  "morges": 0, "lausanne": 12, "rolle": 12, "gland": 15, "aubonne": 20,
  "nyon": 20, "prangins": 22, "genf": 35, "geneve": 35, "genève": 35,
  "moudon": 45, "vevey": 45, "yverdon-les-bains": 45,
  "cheseaux-noréaz": 50, "cheseaux-noreaz": 50, "montreux": 50,
  "estavayer-le-lac": 55, "payerne": 55, "avenches": 60, "aigle": 60,
  "bulle": 70, "neuchâtel": 70, "neuchatel": 70, "neuenburg": 70,
  "martigny": 75, "fribourg": 75, "freiburg": 75, "bern": 80, "murten": 80,
  "sion": 90, "biel": 90, "château-d'oex": 90, "leysin": 90,
  "burgdorf": 95, "sierre": 100, "thun": 100, "la chaux-de-fonds": 100,
  "utzenstorf": 105, "solothurn": 105, "olten": 105, "le locle": 110,
  "aarau": 130, "delémont": 135, "basel": 140, "zürich": 140,
  "zurich": 140, "luzern": 150, "liestal": 155, "winterthur": 155,
  "schaffhausen": 180, "st. gallen": 200, "chur": 230, "vaduz": 240,
  "lugano": 240, "appenzell": 255
};

// Fallback, wenn der Ort nicht in der Tabelle steht: grober Kantonsschnitt.
const REISEZEIT_KANTON = {
  "VD": 45,  "GE": 40,  "NE": 75,  "FR": 80,  "VS": 105, "BE": 100,
  "JU": 140, "SO": 130, "BS": 140, "BL": 150, "AG": 130, "ZH": 140,
  "ZG": 150, "LU": 150, "SZ": 170, "OW": 165, "NW": 165, "UR": 180,
  "GL": 200, "SH": 180, "TG": 190, "SG": 200, "AR": 220, "AI": 250,
  "GR": 230, "TI": 240, "FL": 240
};

// =============================================================================
// HILFSFUNKTIONEN
// =============================================================================

function log(msg) {
  if (ENABLE_DETAILED_LOGGING) Logger.log(msg);
}

function getProps() {
  var p = PropertiesService.getScriptProperties();
  return {
    geminiKey:      p.getProperty("GEMINI_API_KEY") || "",
    openrouterKey:  p.getProperty("OPENROUTER_KEY") || "",
    githubToken:    (p.getProperty("GITHUB_TOKEN") || "").replace(/[^a-zA-Z0-9_-]/g, "")
  };
}

function githubHeaders(token) {
  return {
    "Authorization":        "Bearer " + token,
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent":           "Google-Apps-Script"
  };
}

// Liest eine Datei aus GitHub, gibt { content: String, sha: String } oder null zurueck
function githubGetFile(owner, repo, token, path) {
  var url = GITHUB_API_BASE + owner + "/" + repo + "/contents/" + path;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "GET", headers: githubHeaders(token),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    if (resp.getResponseCode() === 200) {
      var data    = JSON.parse(resp.getContentText());
      var content = Utilities.newBlob(
        Utilities.base64Decode(data.content.replace(/\n/g, ""))
      ).getDataAsString("UTF-8");
      return { content: content, sha: data.sha };
    }
  } catch(e) {
    log("[GITHUB GET FEHLER] " + path + ": " + e.toString());
  }
  return null;
}

// Schreibt eine Datei auf GitHub, holt SHA selbst, Retry bei 409-Konflikt
function githubPutFile(owner, repo, token, path, contentStr, message) {
  var url     = GITHUB_API_BASE + owner + "/" + repo + "/contents/" + path;
  var headers = githubHeaders(token);

  for (var attempt = 0; attempt < 3; attempt++) {
    var sha = null;
    try {
      var gr = UrlFetchApp.fetch(url, {
        method: "GET", headers: headers,
        muteHttpExceptions: true, deadline: FETCH_DEADLINE
      });
      if (gr.getResponseCode() === 200) sha = JSON.parse(gr.getContentText()).sha;
    } catch(e) { /* Datei existiert noch nicht - kein SHA noetig */ }

    var body = {
      message: message,
      content: Utilities.base64Encode(contentStr, Utilities.Charset.UTF_8)
    };
    if (sha) body.sha = sha;

    try {
      var pr   = UrlFetchApp.fetch(url, {
        method: "PUT", headers: headers, contentType: "application/json",
        payload: JSON.stringify(body), muteHttpExceptions: true, deadline: FETCH_DEADLINE
      });
      var code = pr.getResponseCode();
      if (code === 200 || code === 201) {
        log("[GITHUB OK] " + path);
        return true;
      }
      if (code === 409) {
        log("[GITHUB 409] " + path + " - Retry " + (attempt + 1));
        Utilities.sleep(1000);
        continue;
      }
      log("[GITHUB FEHLER] " + path + " (" + code + "): " + pr.getContentText());
      return false;
    } catch(e) {
      log("[GITHUB FEHLER] " + path + ": " + e.toString());
      return false;
    }
  }
  return false;
}

// Leitet GitHub-Koordinaten (owner/repo/xmlPath) aus der targetUrl im Sheet ab
function getRepoCoords(targetUrl) {
  var owner = "obitusde", repo = "schweiz", xmlPath = "veranstaltungen.xml";
  if (targetUrl) {
    var m = targetUrl.match(/:\/\/([^.]+)\.github\.io\/([^\/]+)\/(.+)/i);
    if (m) {
      owner   = m[1].replace(/[^a-zA-Z0-9_-]/g, "");
      repo    = m[2].replace(/[^a-zA-Z0-9_-]/g, "");
      xmlPath = m[3];
    }
  }
  return { owner: owner, repo: repo, xmlPath: xmlPath };
}

// =============================================================================
// DATUM, ORT, TITEL
// =============================================================================

// Heute als lokales Mitternachts-Datum in Schweizer Zeit. Ohne das haengt der
// Vergleich "ist das vorbei?" an der Projekt-Zeitzone und kippt um einen Tag.
function heuteZuerich(now) {
  var t = Utilities.formatDate(now, "Europe/Zurich", "yyyy-MM-dd").split("-");
  return new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]));
}

// "TT.MM.JJJJ" -> Date, sonst null. Akzeptiert auch TT.MM.JJ und Bindestriche.
function parseDatum(s) {
  if (!s) return null;
  var m = String(s).trim().match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (!m) return null;
  var tag = Number(m[1]), monat = Number(m[2]), jahr = Number(m[3]);
  if (jahr < 100) jahr += 2000;
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31) return null;
  var d = new Date(jahr, monat - 1, tag);
  if (d.getDate() !== tag || d.getMonth() !== monat - 1) return null;   // faengt 31.02. ab
  return d;
}

function zweistellig(n) { return (n < 10 ? "0" : "") + n; }

// Jahreszahl nur, wenn es nicht das laufende Jahr ist - spart Breite im Titel.
function formatDatum(d, heute) {
  var s = zweistellig(d.getDate()) + "." + zweistellig(d.getMonth() + 1) + ".";
  if (d.getFullYear() !== heute.getFullYear()) s += d.getFullYear();
  return s;
}

function formatSpanne(start, ende, heute) {
  if (start.getFullYear() === ende.getFullYear() && start.getMonth() === ende.getMonth()) {
    return zweistellig(start.getDate()) + ".-" + formatDatum(ende, heute);
  }
  return formatDatum(start, heute) + "-" + formatDatum(ende, heute);
}

// Ortsangabe in eckigen Klammern, Kantonskuerzel bei allem, was nicht jeder kennt.
function ortLabel(ort, kanton) {
  var name = String(ort || "").trim();
  if (!name) return "";
  var k = String(kanton || "").trim().toUpperCase();
  if (GROSSE_ORTE[name.toLowerCase()] || !k) return name;
  return name + " " + k;
}

// Baut den Item-Titel: "[Morges] Wake Up & Run - am Fr 28.08."
// Ein Tag -> "am <Wochentag> <Datum>", kurze Spanne -> "27.-29.08.",
// alles Laengere -> "bis <Enddatum>". Ohne Datum bleibt der Zusatz weg.
function baueTitel(meta, heute) {
  var start  = parseDatum(meta.start);
  var ende   = parseDatum(meta.ende);
  var zusatz = "";

  if (start && ende && ende.getTime() !== start.getTime()) {
    var tage = Math.round((ende.getTime() - start.getTime()) / MS_PRO_TAG);
    zusatz = (start.getTime() > heute.getTime() && tage <= SPANNE_MAX_TAGE)
      ? formatSpanne(start, ende, heute)
      : "bis " + formatDatum(ende, heute);
  } else if (start) {
    // start == ende oder nur ein Starttag bekannt: echter Eintagestermin.
    zusatz = "am " + WOCHENTAGE[start.getDay()] + " " + formatDatum(start, heute);
  } else if (ende) {
    // Nur ein Enddatum, kein Beginn - das ist eine laufende Ausstellung, kein Termin.
    zusatz = "bis " + formatDatum(ende, heute);
  }

  // "[Morges] [Konzert] Black Colors - am Sa 29.08."
  // Die Gattung steht als zweite Klammer davor. "Sonstiges" bleibt weg - eine
  // Klammer, die nichts sagt, kostet nur Platz in der Zeile.
  var label = ortLabel(meta.ort, meta.kanton);
  var art   = String(meta.art || "").trim();
  art = ART_ANZEIGE[art.toLowerCase()] || art;
  var kopf  = (label ? "[" + label + "] " : "") +
              (art && art.toLowerCase() !== "sonstiges" ? "[" + art + "] " : "");
  return kopf + String(meta.titel || "").trim() + (zusatz ? " - " + zusatz : "");
}

// Welcher Rang reicht bei dieser Reisezeit noch aus?
function erlaubterRang(minuten) {
  for (var i = 0; i < RANG_SCHWELLEN.length; i++) {
    if (minuten <= RANG_SCHWELLEN[i].bisMinuten) return RANG_SCHWELLEN[i].maxRang;
  }
  return 1;
}

// Wird eines der Ankerhaeuser genannt, zaehlt der Anlass als ueberregional.
function istAnkerHaus(meta) {
  var text = (String(meta.titel || "") + " " + String(meta.description || "")).toLowerCase();
  for (var i = 0; i < ANKER_HAEUSER.length; i++) {
    if (text.indexOf(ANKER_HAEUSER[i]) !== -1) return true;
  }
  return false;
}

// Vergleichsschluessel fuer die Dublettenpruefung: Ort plus Titel, reduziert auf
// Buchstaben und Ziffern. "Ella Maillart: Fotografische Erzaehlungen" und
// "Ella Maillart. Fotografische Erzaehlungen" ergeben damit denselben Schluessel.
function dublettenSchluessel(meta) {
  var titel = String(meta.titel || "").toLowerCase()
    .replace(/[^a-z0-9äöüàáâçéèêëîïôùûñ]+/gi, "");
  return String(meta.ort || "").toLowerCase() + "|" + titel;
}

// Zweiter Schluessel, ueber den Link. Quellen veroeffentlichen dieselbe
// Veranstaltung gern zweimal und haengen an den zweiten Slug eine Nummer:
// ".../rencontres-du-prix-du-livre-de-la-ville-de-lausanne" und dasselbe
// mit "-5" am Ende. Ueber den Titel ist das nicht zu fassen, sobald die KI
// den einen uebersetzt und den anderen stehen laesst.
// Leerer Rueckgabewert heisst: kein brauchbarer Slug, nicht vergleichen.
function slugSchluessel(link, meta) {
  var teile = String(link || "").replace(/[?#].*$/, "").replace(/\/+$/, "").split("/");
  var slug  = (teile[teile.length - 1] || "").toLowerCase()
                .replace(/-\d+$/, "")           // angehaengte Zaehlnummer
                .replace(/[^a-z0-9]+/g, "");
  if (slug.length < 5) return "";               // rein numerische IDs taugen nicht
  return "slug|" + String(meta.ort || "").toLowerCase() + "|" + slug;
}

// Reisezeit ab Morges. -1 = unbekannt (weder Ort noch Kanton in der Tabelle).
function reisezeit(ort, kanton) {
  var name = String(ort || "").trim().toLowerCase();
  if (REISEZEIT_ORT.hasOwnProperty(name)) return REISEZEIT_ORT[name];
  var k = String(kanton || "").trim().toUpperCase();
  if (REISEZEIT_KANTON.hasOwnProperty(k)) return REISEZEIT_KANTON[k];
  return -1;
}

// Die drei rechenbaren Ausschlussgruende an EINER Stelle - laeuft ueber frische
// UND ueber gecachte Eintraege, damit nichts unbemerkt im Feed altert.
// Rueckgabe: null = behalten, sonst der Grund als Text fuers Protokoll.
function pruefeMeta(meta, heute) {
  var ausnahme = AUSNAHME_ORTE[String(meta.ort || "").trim().toLowerCase()];
  var min      = reisezeit(meta.ort, meta.kanton);
  if (min === -1 && !ausnahme) {
    return "Ort unbekannt (" + (meta.ort || "?") + "/" + (meta.kanton || "?") + ")";
  }
  if (!ausnahme && min > MAX_REISEZEIT_MIN) {
    return "Zu weit weg: " + meta.ort + " ~" + min + " min ab Morges";
  }

  // Bedeutung gegen Entfernung. Ein unbekanntes Thema vor der Haustuer bleibt
  // drin, weil dort jeder Rang reicht; eine kleine Ausstellung in Zuerich nicht.
  var rang    = parseInt(meta.rang, 10);
  var geraten = !(rang >= 1 && rang <= 3);
  if (geraten) rang = 2;                        // fehlt oder unbrauchbar: Mittelweg
  if (istAnkerHaus(meta)) { rang = 1; geraten = false; }
  var noetig = erlaubterRang(min === -1 ? Infinity : min);
  if (rang > noetig) {
    return "Rang " + rang + (geraten ? " (von der KI nicht gesetzt, angenommen)" : "") +
           ", bei " + (min === -1 ? "unbekannter" : min + " min") +
           " Anreise zaehlt nur Rang " + noetig;
  }

  var start = parseDatum(meta.start);
  var ende  = parseDatum(meta.ende);

  var letzterTag = ende || start;
  if (letzterTag && letzterTag.getTime() < heute.getTime()) {
    return "Vorbei seit " + formatDatum(letzterTag, heute);
  }

  // Kein Datum heisst hier NICHT "Dauerausstellung": der Feed von Plateforme 10
  // liefert zu laufenden Ausstellungen schlicht keine Daten mit. Ob etwas
  // unbefristet laeuft, ist eine Ermessensfrage und steht deshalb als
  // Kriterium (d) im Prompt - dort wurde sie vorher schon zuverlaessig
  // getroffen. Rechenbar ist nur ein vorhandenes, zu weit entferntes Enddatum.

  if (start && start.getTime() > heute.getTime() + VORSCHAU_TAGE * MS_PRO_TAG) {
    return "Faengt erst am " + formatDatum(start, heute) + " an";
  }

  if (ende) {
    var ab   = (start && start.getTime() > heute.getTime()) ? start : heute;
    var tage = Math.round((ende.getTime() - ab.getTime()) / MS_PRO_TAG);
    if (tage > MAX_LAUFZEIT_TAGE) {
      return "Dauerausstellung: laeuft noch " + tage + " Tage";
    }
    if (ende.getDate() === 31 && ende.getMonth() === 11 && tage > JAHRESENDE_MIN_TAGE) {
      return "Dauerausstellung: Enddatum 31.12. als Platzhalter";
    }
  }

  return null;
}

// =============================================================================
// KI-AUFRUF (OpenRouter bevorzugt, Gemini als Rueckfallebene)
// =============================================================================

function callAi(prompt, props, maxTokens) {
  var resp;
  if (props.openrouterKey) {
    resp = UrlFetchApp.fetch(OPENROUTER_ENDPOINT, {
      method: "POST", contentType: "application/json",
      headers: { "Authorization": "Bearer " + props.openrouterKey },
      payload: JSON.stringify({
        model:       OPENROUTER_MODEL,
        messages:    [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens:  maxTokens || 8192
      }),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
  } else if (props.geminiKey) {
    resp = UrlFetchApp.fetch(GEMINI_ENDPOINT + GEMINI_MODEL + ":generateContent", {
      method: "POST", contentType: "application/json",
      headers: { "x-goog-api-key": props.geminiKey },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature:      0,
          maxOutputTokens:  maxTokens || 8192
        }
      }),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
  } else {
    throw new Error("Kein API-Key (OPENROUTER_KEY / GEMINI_API_KEY)");
  }

  if (resp.getResponseCode() >= 400) {
    throw new Error("KI-Fehler " + resp.getResponseCode() + ": " + resp.getContentText().substring(0, 200));
  }
  var jr = JSON.parse(resp.getContentText());
  if (jr.choices && jr.choices.length)       return jr.choices[0].message.content;
  if (jr.candidates && jr.candidates.length) return jr.candidates[0].content.parts[0].text;
  throw new Error("Leere KI-Antwort: " + resp.getContentText().substring(0, 200));
}

// =============================================================================
// CACHE (GitHub-Datei veranstaltungen-cache.json)
// =============================================================================

function loadCache(owner, repo, token) {
  var file = githubGetFile(owner, repo, token, "veranstaltungen-cache.json");
  if (file) {
    try {
      var cache = JSON.parse(file.content);
      log("[CACHE] Geladen: " + Object.keys(cache.entries || {}).length + " Eintraege");
      return cache.entries || {};
    } catch(e) {
      log("[CACHE] Parse-Fehler: " + e.toString());
    }
  }
  log("[CACHE] Kein Cache gefunden - starte leer.");
  return {};
}

function saveCache(owner, repo, token, entries) {
  githubPutFile(owner, repo, token, "veranstaltungen-cache.json",
    JSON.stringify({ entries: entries }), "Cache-Update: Veranstaltungen");
  log("[CACHE] Gespeichert: " + Object.keys(entries).length + " Eintraege.");
}

// Manuell ausfuehren um den Cache zu loeschen
function deleteCache() {
  var props = getProps();
  if (!props.githubToken) {
    Logger.log("[FEHLER] GITHUB_TOKEN nicht gesetzt.");
    return;
  }
  var targetUrl = "";
  try {
    targetUrl = SpreadsheetApp.openById(SPREADSHEET_ID)
      .getSheetByName(SHEET_NAME).getDataRange().getValues()[0][4].toString().trim();
  } catch(e) {
    Logger.log("[WARNUNG] Sheet nicht lesbar - nutze Standardwerte.");
  }

  var c   = getRepoCoords(targetUrl);
  var url = GITHUB_API_BASE + c.owner + "/" + c.repo + "/contents/veranstaltungen-cache.json";

  try {
    var get = UrlFetchApp.fetch(url, {
      method: "GET", headers: githubHeaders(props.githubToken),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    if (get.getResponseCode() === 200) {
      var sha = JSON.parse(get.getContentText()).sha;
      var del = UrlFetchApp.fetch(url, {
        method: "DELETE", headers: githubHeaders(props.githubToken),
        contentType: "application/json",
        payload: JSON.stringify({ message: "Cache geloescht", sha: sha }),
        muteHttpExceptions: true, deadline: FETCH_DEADLINE
      });
      Logger.log(del.getResponseCode() === 200
        ? "[CACHE] Erfolgreich geloescht."
        : "[CACHE FEHLER] " + del.getContentText());
    } else {
      Logger.log("[CACHE] Keine Cache-Datei gefunden.");
    }
  } catch(e) {
    Logger.log("[CACHE FEHLER] " + e.toString());
  }
}

// =============================================================================
// HTML BEREINIGUNG
// =============================================================================

function cleanHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/Delivered by PolitePaul service/gi, "")
    .replace(/\sstyle=["']([^"']*)["']/gi, "")
    .replace(/\sdata-[a-z0-9-]+(=["']?[^"'>\s]*["']?)?/gi, "")
    .replace(/\sclass=["']([^"']*)["']/gi, function(match, classStr) {
      var semanticKeywords = /(location|place|title|date|desc|cat|tag|info|type|kind|label)/i;
      if (semanticKeywords.test(classStr)) {
        var keptWords = classStr.split(/\s+/).filter(function(w) { return semanticKeywords.test(w); });
        return keptWords.length > 0 ? ' class="' + keptWords.join(" ") + '"' : "";
      }
      return "";
    })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<([a-z0-9]+)[^>]*>\s*<\/\1>/gi, "")
    .replace(/<([a-z0-9]+)[^>]*>\s*<\/\1>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Holt Zeichen ausserhalb des lateinischen Bereichs auf ihre Grundform zurueck:
// "Symphởnie der Gewuerze" wird zu "Symphonie der Gewuerze". Das vietnamesische
// o mit Horn und Haken zerfaellt per NFD in o + zwei kombinierende Zeichen; die
// fallen weg, das o bleibt. Deutsche Umlaute und franzoesische Akzente liegen
// innerhalb des erlaubten Bereichs und werden nicht angefasst.
// Der Fehler steckt in der Quelle (museum.ch), nicht in der KI - auf den
// Originaltitel zurueckzufallen wuerde ihn also nur konservieren.
function normalisiereZeichen(text) {
  var s = String(text || "");
  if (!hatFremdeZeichen(s)) return s;
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (!hatFremdeZeichen(ch)) { out += ch; continue; }
    var basis = ch.normalize("NFD").replace(/[\u0300-\u036F]/g, "");
    out += /^[A-Za-z]+$/.test(basis) ? basis : "";
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

// Erkennt Zeichen ausserhalb von Latein, Interpunktion und Waehrungszeichen.
function hatFremdeZeichen(text) {
  return /[^ -ɏ -⁯₠-₿]/.test(String(text || ""));
}

// =============================================================================
// SCRAPE-QUELLEN (Spalte F = "scrape")
// Holt eine Webseite direkt und laesst die KI die Veranstaltungen herauslesen.
// Gibt Items im GLEICHEN Format zurueck wie die RSS-Feeds, damit der restliche
// Ablauf (Filter, Cache, KI-Redaktion, Upload) unveraendert weiterlaeuft.
// =============================================================================

// Sammelt die vollstaendigen Objekte aus dem Array hinter "<key>": [ ... ].
// Laeuft ueber die Klammertiefe und ignoriert Klammern in Zeichenketten, damit
// auch eine mitten im Array abgeschnittene Antwort das liefert, was schon da
// ist. Genau daran ist der Lauf vom 25.08. gescheitert: ein fehlendes "]" am
// Ende hat jeweils alle 30 Eintraege eines Blocks verworfen.
function sammleObjekte(text, key) {
  var k = text.indexOf('"' + key + '"');
  if (k === -1) return [];
  var start = text.indexOf("[", k);
  if (start === -1) return [];

  var out = [], tiefe = 0, objStart = -1, inStr = false, esc = false;
  for (var i = start + 1; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inStr) {
      if (esc)              esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"')  inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (tiefe === 0) objStart = i; tiefe++; }
    else if (ch === "}") {
      tiefe--;
      if (tiefe === 0 && objStart !== -1) {
        try { out.push(JSON.parse(text.substring(objStart, i + 1))); } catch(e) { /* halbes Objekt */ }
        objStart = -1;
      }
    }
    else if (ch === "]" && tiefe === 0) break;
  }
  return out;
}

// Liest die Redaktions-Antwort. Erst der saubere Weg, sonst die Rettung.
function parseRedaktionsAntwort(text) {
  var si = text.indexOf("{"), ei = text.lastIndexOf("}");
  if (si !== -1 && ei > si) {
    try {
      var o = JSON.parse(text.substring(si, ei + 1));
      return {
        updates:     Array.isArray(o.updates)     ? o.updates     : [],
        idsToRemove: Array.isArray(o.idsToRemove) ? o.idsToRemove : [],
        gerettet:    false
      };
    } catch(e) { /* abgeschnitten - unten retten */ }
  }
  return {
    updates:     sammleObjekte(text, "updates"),
    idsToRemove: sammleObjekte(text, "idsToRemove"),
    gerettet:    true
  };
}

// Liest ein JSON-Array - auch wenn die KI-Antwort am Ende abgeschnitten wurde.
// Erst normaler Versuch, dann Rettung bis zum letzten vollstaendigen Objekt.
function safeParseJsonArray(text) {
  if (!text) return null;
  var start = text.indexOf("[");
  if (start === -1) return null;
  var body = text.substring(start);

  var end = body.lastIndexOf("]");
  if (end !== -1) {
    try { return JSON.parse(body.substring(0, end + 1)); } catch(e) {}
  }
  var lastObj = body.lastIndexOf("}");
  if (lastObj === -1) return null;
  try { return JSON.parse(body.substring(0, lastObj + 1) + "]"); } catch(e) { return null; }
}

function fetchAndScrape(pageUrl, feedName, props, now, linkMuster) {
  // Apps-Script-Cache (6h): Scraping-Ergebnis nicht bei jedem Lauf neu holen.
  // Museen Bern aendert sich nicht stuendlich - das spart taeglich ~2 KI-Calls.
  var scriptCache = CacheService.getScriptCache();
  var cacheKey    = "scrape_" + feedName.replace(/\s/g, "_") + "_" + (linkMuster || "");
  var cached      = scriptCache.get(cacheKey);
  if (cached) {
    try {
      var cachedItems = JSON.parse(cached);
      log("[SCRAPE] " + feedName + ": aus Apps-Script-Cache (" + cachedItems.length + " Eintraege)");
      return cachedItems;
    } catch(e) { /* Cache beschaedigt - neu holen */ }
  }
  // 1) Seite holen. Echter Browser-User-Agent, damit wir normales HTML bekommen
  //    (UrlFetchApp ignoriert robots.txt - im Gegensatz zu PolitePaul).
  var resp;
  try {
    resp = UrlFetchApp.fetch(pageUrl, {
      muteHttpExceptions: true, followRedirects: true, deadline: FETCH_DEADLINE,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "de-CH,de;q=0.9"
      }
    });
  } catch(e) {
    log("[SCRAPE] Abruf-Fehler bei " + pageUrl + ": " + e.toString());
    return [];
  }
  if (resp.getResponseCode() >= 400) {
    log("[SCRAPE] HTTP " + resp.getResponseCode() + " bei " + pageUrl);
    return [];
  }
  if (!props.geminiKey && !props.openrouterKey) {
    log("[SCRAPE] Kein API-Key (OPENROUTER_KEY/GEMINI_API_KEY) - Extraktion nicht moeglich.");
    return [];
  }

  var rawPage = resp.getContentText("UTF-8");
  var full    = cleanHtml(rawPage);

  // Pro Ausstellung einen NICHT-ueberlappenden Textblock bauen: vom jeweiligen
  // Link bis zum naechsten Link. Vorher war das der Fehler - ueberlappende Fenster
  // sahen fuer das Modell wie 40x derselbe Text aus, darum gab es nur 1-3 zurueck.
  // HTML-Tags werden entfernt, das Modell bekommt sauberen Text pro Eintrag.
  // Welche Links sind Veranstaltungen? Kommt aus Spalte G der Tabelle, als
  // Teilstring ("event-details") oder als /regex/. Ohne Angabe bleibt es bei
  // "event-details", damit die Bern-Zeile ohne Spalte G weiterlaeuft.
  var muster = String(linkMuster || "").trim() || "event-details";
  var linkPruefung;
  if (muster.length > 2 && muster.charAt(0) === "/" && muster.charAt(muster.length - 1) === "/") {
    try {
      linkPruefung = new RegExp(muster.substring(1, muster.length - 1), "i");
    } catch(e) {
      log("[SCRAPE] Ungueltiges Muster '" + muster + "' bei " + feedName + ": " + e.toString());
      return [];
    }
  } else {
    var wortlaut = muster.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    linkPruefung = new RegExp(wortlaut, "i");
  }

  var matches = [];
  var re = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi, mm;
  while ((mm = re.exec(full)) !== null) {
    if (linkPruefung.test(mm[1])) matches.push({ href: mm[1], idx: mm.index });
  }
  if (matches.length === 0) {
    log("[SCRAPE] " + feedName + ": kein Link passt auf '" + muster + "'. " +
        "Muster pruefen, oder die Seite rendert ihre Liste erst im Browser.");
    return [];
  }
  if (matches.length > SCRAPE_MAX_LINKS) {
    log("[SCRAPE] " + feedName + ": " + matches.length + " Links gefunden, " +
        "nehme die ersten " + SCRAPE_MAX_LINKS + ". Wenn die Seite nicht nach Datum " +
        "sortiert ist, besser eine gefilterte URL eintragen.");
    matches = matches.slice(0, SCRAPE_MAX_LINKS);
  }

  var seenHref = {}, blocks = [];
  for (var i = 0; i < matches.length; i++) {
    var href = matches[i].href;
    if (seenHref[href]) continue;                 // gleiche URL nur einmal
    seenHref[href] = true;
    var prevIdx = (i > 0) ? matches[i - 1].idx : 0;
    var nextIdx = (i + 1 < matches.length) ? matches[i + 1].idx : full.length;
    var start   = Math.max(prevIdx, matches[i].idx - 150);   // kein Ueberlapp nach hinten
    var end     = Math.min(nextIdx, matches[i].idx + 800);   // kein Ueberlapp nach vorn
    var text    = full.substring(start, end).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    blocks.push("URL: " + href + "\nTEXT: " + text);
  }

  // Basis-Adresse (z.B. https://www.museen-bern.ch) fuer absolute Links
  var m      = pageUrl.match(/^(https?:\/\/[^\/]+)/i);
  var origin = m ? m[1] : "";

  // Bloecke in Haeppchen zu 40 aufteilen - so bleibt jeder KI-Call ueberschaubar
  // und das Modell gibt nicht nach einem Bruchteil der Liste auf.
  var CHUNK = 40;
  var arr   = [];

  for (var ci = 0; ci < blocks.length; ci += CHUNK) {
    var chunk     = blocks.slice(ci, ci + CHUNK);
    var htmlChunk = chunk.join("\n----\n");

    var prompt =
      "Unten stehen Eintraege einer Veranstaltungsseite, getrennt durch '----'. " +
      "Jeder Eintrag beginnt mit 'URL:' und dann 'TEXT:' (der Text genau dieses einen Eintrags).\n" +
      "Gib ein JSON-Array zurueck, mit einem Objekt pro Eintrag, der einen echten Veranstaltungstitel hat. " +
      "Felder pro Objekt:\n" +
      '- "url": exakt die Zeichenkette nach "URL:" dieses Eintrags\n' +
      '- "title": Titel der Veranstaltung aus dem TEXT\n' +
      '- "museum": Veranstaltungsort oder Institution falls erkennbar, sonst ""\n' +
      '- "dateRange": Laufzeit oder Datum falls vorhanden, sonst ""\n' +
      '- "description": max. 200 Zeichen aus dem TEXT, sonst ""\n' +
      "Jeder Eintrag ist eigenstaendig - fasse NICHTS zusammen, dedupliziere nicht, lass keinen " +
      "Eintrag mit Titel aus. Reine Navigations-/Kategorie-Eintraege (z.B. 'Atelier', 'Thementouren', " +
      "'Game') ohne echten Veranstaltungstitel darfst du weglassen.\n\nEINTRAEGE:\n" + htmlChunk;

    var rawText;
    try {
      rawText = callAi(prompt, props, 8192);
    } catch(e) {
      log("[SCRAPE] Block " + ci + ": " + e.toString());
      continue;
    }

    var chunkArr = safeParseJsonArray(rawText);
    if (chunkArr && Array.isArray(chunkArr)) {
      arr = arr.concat(chunkArr);
    } else {
      log("[SCRAPE] Block " + ci + ": JSON nicht lesbar");
    }
    if (ci + CHUNK < blocks.length) Utilities.sleep(500);
  }

  // 4) In das gleiche Item-Format wie die RSS-Feeds umwandeln
  var items = [];
  arr.forEach(function(x) {
    if (!x || !x.title || !x.url) return;

    var href = String(x.url).trim();
    var link;
    if (/^https?:\/\//i.test(href))   link = href;            // schon absolut
    else if (href.charAt(0) === "/")  link = origin + href;   // /de/...
    else                              link = origin + "/" + href;

    var descParts = [x.museum, x.dateRange, x.description].filter(Boolean);

    items.push({
      title:       String(x.title).trim(),
      link:        link,
      guid:        link,
      description: cleanHtml(descParts.join(" - ")),
      pubDate:     now.toUTCString(),
      timestamp:   now.getTime(),
      feedName:    feedName
    });
  });

  // Ergebnis 6h cachen - spart KI-Calls bei mehreren Laeufen pro Tag
  try {
    scriptCache.put(cacheKey, JSON.stringify(items), 21600);
  } catch(e) { /* Cache voll - kein Problem, naechster Lauf holt neu */ }

  log("[SCRAPE] " + feedName + ": " + items.length + " Veranstaltungen extrahiert (Muster '" + muster + "').");
  return items;
}

// =============================================================================
// TRIGGER SETUP (optional - einmalig manuell ausfuehren)
// =============================================================================

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "updateRSSFeed") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("updateRSSFeed").timeBased().everyDays(1).atHour(6).create();
  Logger.log("[TRIGGER] Taeglicher Trigger um 06:00 angelegt.");
}

// =============================================================================
// HAUPTFUNKTION
// =============================================================================

function updateRSSFeed() {
  var now      = new Date();
  var heute    = heuteZuerich(now);
  var todayStr = Utilities.formatDate(now, "Europe/Zurich", "dd.MM.yyyy");
  var nowMs    = now.getTime();
  var props    = getProps();

  // --- Tabelle einlesen ---
  var sheet     = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  var data      = sheet.getDataRange().getValues();
  var feedUrls  = [], urlToNameMap = {}, urlToTypeMap = {}, urlToMusterMap = {};
  var excludeWords = [], aiExclusions = [];
  var targetUrl = data[0] && data[0][4] ? data[0][4].toString().trim() : "";

  for (var i = 0; i < data.length; i++) {
    if (data[i][0]) {
      var u = data[i][0].toString().trim();
      if (u.toLowerCase().startsWith("http")) {
        feedUrls.push(u);
        urlToNameMap[u] = data[i][1] ? data[i][1].toString().trim() : "News";
        // Spalte F (Index 5): "scrape" = Webseite scrapen, sonst normales RSS
        urlToTypeMap[u] = data[i][5] ? data[i][5].toString().trim().toLowerCase() : "rss";
        // Spalte G (Index 6): Link-Muster fuer scrape-Quellen
        urlToMusterMap[u] = data[i][6] ? data[i][6].toString().trim() : "";
      }
    }
    if (data[i][2]) excludeWords.push(data[i][2].toString().toLowerCase().trim());
    if (data[i][3]) aiExclusions.push(data[i][3].toString().trim());
  }

  var c             = getRepoCoords(targetUrl);
  var cacheEntries  = props.githubToken ? loadCache(c.owner, c.repo, props.githubToken) : {};
  var cacheExpireMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

  var staticLog = [], aiLog = [], cacheLog = [], noLinkLog = [], regelLog = [], ohneMetaLog = [], finalLog = [];

  log("=== START FEED-AKTUALISIERUNG (" + todayStr + ") ===");
  log("Feeds: " + feedUrls.length + " | Keywords: " + excludeWords.length + " | KI-Themen: " + aiExclusions.length);

  // --- RSS-Feeds abrufen ---
  var allItems  = [];
  var seenLinks = {};

  feedUrls.forEach(function(feedUrl) {
    var countBefore = allItems.length;
    var feedName    = urlToNameMap[feedUrl] || "News";

    // --- SCRAPE-Quellen gesondert behandeln (Spalte F = "scrape") ---
    if ((urlToTypeMap[feedUrl] || "rss") === "scrape") {
      try {
        var scraped = fetchAndScrape(feedUrl, feedName, props, now, urlToMusterMap[feedUrl]);
        scraped.forEach(function(item) {
          if (!item.link || seenLinks[item.link]) return;

          // gleicher Keyword-Filter wie bei den RSS-Feeds
          var matchedWord = "";
          var blocked = excludeWords.some(function(w) {
            if (!w) return false;
            var hit = item.title.toLowerCase().includes(w) || item.description.toLowerCase().includes(w);
            if (hit) matchedWord = w;
            return hit;
          });
          if (blocked) {
            staticLog.push("- Geloescht [Keyword '" + matchedWord + "']: '" + item.title + "'");
            return;
          }

          seenLinks[item.link] = true;
          allItems.push(item);
        });
        log("[SCRAPE OK] " + feedName + " -> " + (allItems.length - countBefore) + " Artikel");
      } catch(err) {
        Logger.log("[SCRAPE FEHLER] " + feedUrl + " -> " + err.toString());
      }
      return; // diese Zeile NICHT als RSS weiterverarbeiten
    }

    // --- normale RSS-Feeds ---
    try {
      var response = UrlFetchApp.fetch(feedUrl, {
        validateHttpsCertificates: false, muteHttpExceptions: true, deadline: FETCH_DEADLINE
      });
      var bytes   = response.getContent();
      var charset = "UTF-8";
      var peek    = Utilities.newBlob(bytes.slice(0, 200)).getDataAsString("ISO-8859-1");
      var xm      = peek.match(/encoding=["']([^"']+)["']/i);
      if (xm && xm[1]) {
        charset = xm[1].trim().toUpperCase();
      } else {
        var ct  = response.getHeaders()["Content-Type"] || response.getHeaders()["content-type"] || "";
        var cm  = ct.match(/charset=([^;]+)/i);
        if (cm && cm[1]) charset = cm[1].trim().toUpperCase().replace(/['"]/g, "");
      }
      var blob = Utilities.newBlob(bytes);
      var raw  = blob.getDataAsString(charset);
      if      (charset === "ISO-8859-1" && /[ÂÃ][-¿]/.test(raw)) { charset = "UTF-8";      raw = blob.getDataAsString("UTF-8"); }
      else if (charset === "UTF-8"      && raw.includes("�"))                    { charset = "ISO-8859-1"; raw = blob.getDataAsString("ISO-8859-1"); }

      var xml     = XmlService.parse(raw);
      var root    = xml.getRootElement();
      var ns      = root.getNamespace();
      var channel = root.getChild("channel", ns) || root.getChild("channel");
      var items   = channel
        ? (channel.getChildren("item", channel.getNamespace()) || channel.getChildren("item"))
        : (root.getChildren("entry", ns) || root.getChildren("entry"));

      items.forEach(function(item) {
        var iNs   = item.getNamespace();
        var title = item.getChildText("title", iNs) || item.getChildText("title") || "";
        if (!title) return;

        var link = "", linkEl = item.getChild("link", iNs) || item.getChild("link");
        if (linkEl) link = linkEl.getText() || (linkEl.getAttribute("href") ? linkEl.getAttribute("href").getValue() : "");
        link = link.trim();

        if (!link) {
          noLinkLog.push("- Kein Link: '" + title.trim() + "'");
          return;
        }
        if (seenLinks[link]) return;

        var pubDateStr  = item.getChildText("pubDate", iNs)   || item.getChildText("pubDate")      ||
                          item.getChildText("published", iNs) || item.getChildText("updated", iNs) || "";
        var pubDate     = new Date(pubDateStr);
        var timestamp   = isNaN(pubDate.getTime()) ? 0 : pubDate.getTime();
        var rawDesc     = item.getChildText("description", iNs) || item.getChildText("description") ||
                          item.getChildText("summary", iNs)     || item.getChildText("content", iNs) || "";
        var description = cleanHtml(rawDesc);
        var guid        = item.getChildText("guid", iNs) || item.getChildText("guid") ||
                          item.getChildText("id", iNs)   || item.getChildText("id")   || link;

        var matchedWord = "";
        var blocked = excludeWords.some(function(w) {
          if (!w) return false;
          var hit = title.toLowerCase().includes(w) || description.toLowerCase().includes(w);
          if (hit) matchedWord = w;
          return hit;
        });
        if (blocked) {
          staticLog.push("- Geloescht [Keyword '" + matchedWord + "']: '" + title.trim() + "'");
          return;
        }

        seenLinks[link] = true;
        allItems.push({
          title: title.trim(), link: link, guid: guid.trim(), description: description,
          pubDate: isNaN(pubDate.getTime()) ? now.toUTCString() : pubDate.toUTCString(),
          timestamp: timestamp, feedName: feedName
        });
      });

      log("[FEED OK] " + feedName + " (" + charset + ") -> " + (allItems.length - countBefore) + " Artikel");
    } catch(err) {
      Logger.log("[FEED FEHLER] " + feedUrl + " -> " + err.toString());
    }
  });

  allItems.sort(function(a, b) { return b.timestamp - a.timestamp; });
  log("Nach statischem Filter: " + allItems.length + " Artikel");

  // --- Cache-Pruefung ---
  // Der Cache liefert nur noch die KI-Felder. Ob ein Eintrag noch in den Feed
  // gehoert, entscheidet weiter unten pruefeMeta() - fuer alle Eintraege gleich.
  var itemsToAnalyze = [];

  allItems.forEach(function(item) {
    var cached = cacheEntries[item.link];
    var frisch = cached && cached.v === CACHE_VERSION && (nowMs - cached.cachedAt) < cacheExpireMs;
    if (frisch) {
      item._fromCache = true;
      if (cached.removed) {
        aiLog.push("- Geloescht [Cache: " + cached.reason + "]: '" + (cached.meta && cached.meta.titel || item.title) + "'");
        item._cacheRemoved = true;
      } else {
        item.meta = cached.meta;
        cacheLog.push("- Cache: '" + cached.meta.titel + "'");
      }
    } else {
      itemsToAnalyze.push(item);
    }
  });

  log("Aus Cache: " + (allItems.length - itemsToAnalyze.length) + " | Neu fuer KI: " + itemsToAnalyze.length);

  // --- KI-Verarbeitung -------------------------------------------------------
  // Zwei Durchgaenge. Der zweite holt die Eintraege nach, zu denen die KI im
  // ersten nichts geliefert hat - das kleine Modell ueberspringt gelegentlich
  // einzelne Artikel, am 25.08. vier von 46. Die standen dann roh im Feed.
  // Seit dem Modellwechsel kostet ein Block 2-4 Sekunden statt 52, ein zweiter
  // Durchgang faellt also kaum ins Gewicht.
  var formattedExclusions = aiExclusions.map(function(l) { return "- " + l; }).join("\n");

  function baueRedaktionsPrompt(chunkItems) {
    var itemsForAi = chunkItems.map(function(item, li) {
      return { id: li, title: item.title, description: item.description.substring(0, 3000),
               url: item.link, feed: item.feedName };
    });

    var exclusionBlock = aiExclusions.length > 0
      ? "a) Thema gehoert zu diesen Ausschlusskriterien (NUR diese, keine eigenen Urteile):\n" + formattedExclusions + "\n"
      : "a) Keine Ausschlusskriterien definiert - nach Thema nichts entfernen.\n";

    // Die KI liefert Felder, keine fertigen Titel. Datum, Entfernung und
    // Dauerausstellungen entscheidet danach das Skript.
    return "Redakteur, Veranstaltungskalender Schweiz. Heute: " + todayStr + ".\n\n" +
      "Gib zu JEDEM behaltenen Artikel ein Objekt in \"updates\" zurueck. Felder:\n" +
      '- "ort": Ortsname der Veranstaltung in Originalschreibweise (Lausanne, Zuerich, Cheseaux-Noreaz). ' +
      "Drei erlaubte Herleitungen, in dieser Reihenfolge:\n" +
      "  (1) Ein Ortsname, der im Titel oder in der Beschreibung steht - auch als Teil eines Namens: " +
      "'Morges Open Air' -> Morges, 'Expo Avenches' -> Avenches, 'Chateau de Vullierens' -> Vullierens.\n" +
      "  (2) Ein namentlich genanntes Haus, dessen Ort du kennst: mudac -> Lausanne, " +
      "Landesmuseum -> Zuerich, Musee Ariana -> Genf, Kunstmuseum Thun -> Thun.\n" +
      "  (3) Ein Ortsname in der URL des Eintrags.\n" +
      "VERBOTEN ist die Herleitung aus dem Feed-Namen: 'Vaud.de Morges' bezeichnet eine Region, nicht " +
      "den Veranstaltungsort. Greift keine der drei Herleitungen, setze ort auf \"\" und nimm den " +
      "Eintrag in idsToRemove mit reason 'Ort unbekannt' auf. Erfinde nie einen Ort und schreibe nie " +
      "einen geratenen Ort in die Beschreibung.\n" +
      '- "kanton": Kantonskuerzel des Orts (VD, GE, VS, NE, FR, BE, ZH, BS, BL, LU, SG, AI, AR, GR, TI, ...), ' +
      'fuer Liechtenstein "FL". Immer ausfuellen, wenn ein Ort bestimmt wurde.\n' +
      '- "titel": Titel auf DEUTSCH - IMMER. Franzoesische, englische und italienische Titel MUSST du ' +
      "uebersetzen, auch Ausstellungstitel, auch wenn sie gut klingen. 'Les aventures de Gouttelette' wird " +
      "'Die Abenteuer von Gouttelette', 'Et nous alors?' wird 'Und wir?'. Kein halb uebersetzter Titel. " +
      "NICHT uebersetzt werden ausschliesslich Eigennamen: Personennamen (Alfredo Jaar, Ted Joans), " +
      "Festival- und Bandnamen (Paillote Festival, Black Colors), Hausnamen (Musee Alexis Forel) und " +
      "Werktitel, die als Zitat stehen. Kein Ort, kein Datum und keine Gattungsangabe im Titel - " +
      "'Ausstellung' oder 'Konzert' gehoert in das Feld art, nicht in den Titel.\n" +
      '- "start": erster Tag als TT.MM.JJJJ, sonst "".\n' +
      '- "ende": letzter Tag als TT.MM.JJJJ. Eintaegige Veranstaltung: ende = start. Unbekannt: "".\n' +
      '- "art": genau eines von Ausstellung, Konzert, Festival, Fuehrung, Lesung, Theater, Kino, Markt, Sport, Familie, Vortrag, Sonstiges.\n' +
      '- "rang": Bedeutung des Anlasses, 1 bis 3.\n' +
      "  1 = ueberregional. Haus von nationalem Rang (Kunstmuseum Bern, Zentrum Paul Klee, Landesmuseum, " +
      "Kunsthaus Zuerich, MEG, Musee d'art et d'histoire, Photo Elysee, mudac, MCBA), Retrospektive oder " +
      "Werkschau eines bekannten Namens, grosse Sonderausstellung. Eine Van-Gogh-Schau ist immer 1.\n" +
      "  2 = etabliertes regionales Museum, solide Sonderausstellung, groesseres Festival.\n" +
      "  3 = Kabinett-, Vereins-, Schul- oder Ortsmuseum, Vitrinenausstellung, Begleitprogramm, " +
      "Spielnachmittag, Vereinsanlass.\n" +
      "  Im Zweifel 2. Der Rang bewertet die Bedeutung des ANLASSES, nicht wie spannend das Thema klingt: " +
      "ein sperriges Thema in einem grossen Haus bleibt 1, ein huebsches Thema im Ortsmuseum bleibt 3. " +
      "Das Skript entscheidet danach selbst, welcher Rang bei welcher Entfernung reicht.\n" +
      '- "description": max. 220 Zeichen Deutsch: Was/Thema/Highlight, am Ende der Veranstaltungsort ' +
      "(vollstaendiger Hausname, Stadt), sofern er im Text steht. Kein Fuelltext.\n\n" +
      "FORMAT: Antworte als EINE Zeile reines JSON, ohne Zeilenumbrueche, ohne Einrueckung, ohne Markdown. " +
      "Jedes Zeichen kostet Antwortzeit, und eine zu lange Antwort wird abgeschnitten.\n\n" +
      "DATUM: Jahreszahlen im Titel (Anno 1811, Sommer 1968) sind KEINE Termine. Steht nur ein einziges " +
      "Datum, ist die Veranstaltung eintaegig - dann start = ende. Erfinde nie ein Datum, lieber \"\".\n\n" +
      "ENTFERNEN nur wenn:\n" +
      exclusionBlock +
      "b) Duplikat - exakt einen behalten, nie alle loeschen. Auch Duplikate aus frueheren Bloecken beachten. " +
      "Eine Vernissage oder Fuehrung zu einer Ausstellung, die als eigener Eintrag existiert, ist ein Duplikat.\n" +
      "c) Ort weder im Text genannt noch ueber ein benanntes Haus bestimmbar.\n" +
      "Nach Datum oder Entfernung NICHT selbst filtern - das macht das Skript.\n\n" +
      "PFLICHT: Jeder Artikel muss entweder in updates oder in idsToRemove auftauchen. Lass keinen aus.\n" +
      "JSON (kein Markdown):\n" +
      "{\"idsToRemove\":[{\"id\":3,\"reason\":\"Duplikat\"}]," +
      "\"updates\":[{\"id\":0,\"ort\":\"Morges\",\"kanton\":\"VD\",\"titel\":\"Wake Up & Run\"," +
      "\"start\":\"28.08.2026\",\"ende\":\"28.08.2026\",\"art\":\"Sport\",\"rang\":3," +
      "\"description\":\"Fruehmorgendlicher Lauf durch die Stadt. Start Place du Casino, Morges.\"}]}\n\n" +
      "Artikel:\n" + JSON.stringify(itemsForAi);
  }

  function verarbeiteBlock(chunkItems, etikett) {
    try {
      var rawText  = callAi(baueRedaktionsPrompt(chunkItems), props, AI_MAX_TOKENS).trim();
      var aiResult = parseRedaktionsAntwort(rawText);

      if (aiResult.gerettet) {
        // Antwort war unvollstaendig. Was gerettet wurde, wird verwendet; der
        // Rest des Blocks kommt in den zweiten Durchgang.
        var meldung = "Antwort abgeschnitten (" + rawText.length + " Zeichen), " +
                      aiResult.updates.length + " von " + chunkItems.length + " Eintraegen gerettet";
        Logger.log("[KI TEILWEISE] " + etikett + ": " + meldung);
        Logger.log("[KI ROHTEXT-ENDE] ..." + rawText.substring(Math.max(0, rawText.length - 200)));
        aiLog.push("- " + meldung + " [" + etikett + "]");
      }

      aiResult.updates.forEach(function(upd) {
        if (!upd || typeof upd !== "object") return;
        var origItem = chunkItems[parseInt(upd.id, 10)];
        if (!origItem) return;

        var meta = {
          ort:         String(upd.ort    || "").trim(),
          kanton:      String(upd.kanton || "").trim().toUpperCase(),
          titel:       String(upd.titel  || origItem.title).trim(),
          start:       String(upd.start  || "").trim(),
          ende:        String(upd.ende   || "").trim(),
          art:         String(upd.art    || "Sonstiges").trim(),
          rang:        parseInt(upd.rang, 10) || 2,
          description: String(upd.description || origItem.description).trim()
        };
        if (hatFremdeZeichen(meta.titel) || hatFremdeZeichen(meta.description)) {
          var vorher       = meta.titel;
          meta.titel       = normalisiereZeichen(meta.titel);
          meta.description = normalisiereZeichen(meta.description);
          if (vorher !== meta.titel) {
            aiLog.push("- Zeichen bereinigt: '" + vorher + "' -> '" + meta.titel + "'");
          }
        }

        origItem.meta = meta;
        cacheEntries[origItem.link] = {
          v: CACHE_VERSION, meta: meta, cachedAt: nowMs, removed: false, reason: ""
        };
      });

      aiResult.idsToRemove.forEach(function(entry) {
        var localId  = typeof entry === "object" ? parseInt(entry.id, 10) : parseInt(entry, 10);
        var reason   = typeof entry === "object" ? (entry.reason || "Kein Grund") : "Kein Grund";
        var origItem = chunkItems[localId];
        if (!origItem) return;
        origItem._cacheRemoved = true;
        aiLog.push("- Geloescht [" + reason + "]: '" + origItem.title + "' [Feed: " + origItem.feedName + "]");
        cacheEntries[origItem.link] = {
          v: CACHE_VERSION, meta: { titel: origItem.title }, cachedAt: nowMs,
          removed: true, reason: reason
        };
      });
    } catch(aiErr) {
      Logger.log("[KI FEHLER] " + etikett + ": " + aiErr.toString());
    }
  }

  // Arbeitet eine Liste blockweise ab. Bricht ab, wenn das Zeitbudget der
  // Ausfuehrung erreicht ist, und meldet, wie viele offen blieben.
  function redaktionsDurchgang(liste, etikett) {
    for (var i = 0; i < liste.length; i += AI_CHUNK_SIZE) {
      if (Date.now() - nowMs > AI_BUDGET_MS) {
        var offen = liste.length - i;
        Logger.log("[KI GESTOPPT] Zeitbudget erreicht, " + offen + " Eintraege bleiben fuer den naechsten Lauf.");
        aiLog.push("- Zeitbudget erreicht: " + offen + " Eintraege unbearbeitet, werden beim naechsten Lauf nachgeholt.");
        return offen;
      }
      var chunk = liste.slice(i, i + AI_CHUNK_SIZE);
      log("[KI] " + etikett + " " + i + "-" + (i + chunk.length - 1) + " (" + chunk.length + " Artikel)");
      verarbeiteBlock(chunk, etikett + " " + i);
      if (i + AI_CHUNK_SIZE < liste.length) Utilities.sleep(1000);
    }
    return 0;
  }

  if (itemsToAnalyze.length > 0 && (props.openrouterKey || props.geminiKey)) {
    redaktionsDurchgang(itemsToAnalyze, "Block");

    var nachzuegler = itemsToAnalyze.filter(function(it) { return !it.meta && !it._cacheRemoved; });
    if (nachzuegler.length > 0) {
      log("[KI] " + nachzuegler.length + " Eintraege ohne Ergebnis - zweiter Versuch.");
      redaktionsDurchgang(nachzuegler, "Nachzuegler");

      var immerNoch = itemsToAnalyze.filter(function(it) { return !it.meta && !it._cacheRemoved; }).length;
      aiLog.push("- Zweiter Versuch fuer " + nachzuegler.length + " uebersprungene Eintraege, " +
                 (nachzuegler.length - immerNoch) + " davon nachgeholt.");
    }

  } else if (itemsToAnalyze.length > 0) {
    log("[KI] Kein API-Key - Analyse uebersprungen.");
  }

  // --- Regelfilter: Datum, Entfernung, Dauerausstellung -----------------------
  // Laeuft ueber ALLE Eintraege, auch die aus dem Cache. Genau hier hing vorher
  // der Fehler, dass abgelaufene Cache-Eintraege im Feed stehenblieben.
  var idsToRemoveSet = {}, dublettenSet = {};

  allItems.forEach(function(item, idx) {
    if (item._cacheRemoved) { idsToRemoveSet[idx] = true; return; }
    if (!item.meta) {
      // Die KI hat zu diesem Eintrag nichts geliefert (Fehler, Zeitlimit,
      // abgeschnittene Antwort). Dann bleibt er so im Feed, wie die Quelle ihn
      // liefert - unformatiert, aber vorhanden. Ihn zu verwerfen hiesse, einen
      // KI-Ausfall in einen leeren Feed zu uebersetzen.
      // Auch der Roh-Titel bekommt die Zeichenbereinigung ab: der Fehler in
      // "Symphởnie der Gewuerze" steckt in der Quelle, nicht in der KI.
      item.title       = normalisiereZeichen(item.title);
      item.description = normalisiereZeichen(item.description);
      ohneMetaLog.push("- Unveraendert [Keine KI-Daten]: '" + item.title + "' [Feed: " + item.feedName + "]");
      return;
    }
    var grund = pruefeMeta(item.meta, heute);
    if (grund) {
      idsToRemoveSet[idx] = true;
      regelLog.push("- Geloescht [" + grund + "]: '" + item.meta.titel + "' [Feed: " + item.feedName + "]");
      return;
    }
    item.title       = baueTitel(item.meta, heute);
    item.description = item.meta.description;
    item.kategorie   = item.meta.art;
  });
  allItems = allItems.filter(function(_, idx) { return !idsToRemoveSet[idx]; });

  // --- Dubletten ueber Quell- und Blockgrenzen hinweg -------------------------
  // Die KI sieht immer nur einen Block und kann Wiederholungen aus anderen
  // Bloecken nicht kennen - mit 6 Eintraegen pro Block erst recht nicht.
  // Gleicher Ort und gleicher Titel heisst: einmal reicht. Es gewinnt der
  // Eintrag mit Datum, sonst der erste.
  var besteProSchluessel = {};
  allItems.forEach(function(item, idx) {
    if (!item.meta) return;                       // ohne KI-Daten kein Vergleich

    var schluessel = [dublettenSchluessel(item.meta), slugSchluessel(item.link, item.meta)]
                       .filter(function(k) { return k; });
    var hatDatum   = !!(parseDatum(item.meta.start) || parseDatum(item.meta.ende));

    var bisher = null;
    for (var i = 0; i < schluessel.length; i++) {
      if (besteProSchluessel[schluessel[i]] !== undefined) { bisher = besteProSchluessel[schluessel[i]]; break; }
    }

    // Zwei Quellen nennen dieselbe Ausstellung verschieden lang:
    // "Susanne Keller. Hinterkammer des Auges" und "Hinterkammer des Auges".
    // Steckt der eine Titel vollstaendig im anderen und ist der Ort derselbe,
    // ist es dieselbe Veranstaltung. Die Mindestlaenge verhindert, dass kurze
    // Allerweltstitel alles zusammenziehen.
    if (bisher === null) {
      var meins    = dublettenSchluessel(item.meta).split("|");
      var meinOrt  = meins[0], meinTitel = meins[1] || "";
      for (var k in besteProSchluessel) {
        if (k.indexOf("slug|") === 0) continue;              // nur Titelschluessel
        var teile = k.split("|");
        if (teile[0] !== meinOrt) continue;                  // anderer Ort, andere Veranstaltung
        var anderer = teile[1] || "";
        var kurz = anderer.length < meinTitel.length ? anderer : meinTitel;
        var lang = anderer.length < meinTitel.length ? meinTitel : anderer;
        if (kurz.length >= 15 && lang.indexOf(kurz) !== -1) {
          bisher = besteProSchluessel[k];
          break;
        }
      }
    }

    if (bisher === null) {
      var neu = { idx: idx, hatDatum: hatDatum, schluessel: schluessel };
      schluessel.forEach(function(k) { besteProSchluessel[k] = neu; });
      return;
    }

    // Es gewinnt der Eintrag mit Datum; steht es bei beiden gleich, der mit dem
    // aussagekraeftigeren Titel ("Susanne Keller. Hinterkammer des Auges"
    // schlaegt "Hinterkammer des Auges").
    var neuGewinnt;
    if (hatDatum !== bisher.hatDatum) {
      neuGewinnt = hatDatum;
    } else {
      neuGewinnt = String(item.meta.titel || "").length >
                   String(allItems[bisher.idx].meta.titel || "").length;
    }

    var sieger, verlierer;
    if (neuGewinnt) { sieger = { idx: idx, hatDatum: hatDatum, schluessel: schluessel }; verlierer = bisher.idx; }
    else            { sieger = bisher;                                                   verlierer = idx; }

    // Beide Schluesselsaetze auf den Sieger zeigen lassen, damit auch eine
    // dritte Dublette erkannt wird, egal ueber welchen Schluessel sie passt.
    bisher.schluessel.concat(schluessel).forEach(function(k) { besteProSchluessel[k] = sieger; });
    sieger.schluessel = bisher.schluessel.concat(schluessel);

    regelLog.push("- Geloescht [Dublette von '" + allItems[sieger.idx].meta.titel +
                  "']: '" + allItems[verlierer].meta.titel + "' [Feed: " + allItems[verlierer].feedName + "]");
    dublettenSet[verlierer] = true;
  });
  allItems = allItems.filter(function(_, idx) { return !dublettenSet[idx]; });

  if (props.githubToken) saveCache(c.owner, c.repo, props.githubToken, cacheEntries);

  // --- RSS-Feed aufbauen ---
  var rssEl  = XmlService.createElement("rss").setAttribute("version", "2.0");
  var chanEl = XmlService.createElement("channel");
  rssEl.addContent(chanEl);
  chanEl.addContent(XmlService.createElement("title").setText("Veranstaltungen"));
  chanEl.addContent(XmlService.createElement("link").setText(targetUrl || "https://obitusde.github.io/schweiz/veranstaltungen.xml"));
  chanEl.addContent(XmlService.createElement("description").setText("KI-gefilterter Veranstaltungsfeed"));
  chanEl.addContent(XmlService.createElement("language").setText("de"));
  chanEl.addContent(XmlService.createElement("lastBuildDate").setText(now.toUTCString()));
  chanEl.addContent(XmlService.createElement("ttl").setText("360"));

  allItems.forEach(function(item) {
    finalLog.push("- [" + item.feedName + "] " + item.title);
    var el = XmlService.createElement("item");
    el.addContent(XmlService.createElement("title").setText(item.title));
    el.addContent(XmlService.createElement("link").setText(item.link));
    el.addContent(XmlService.createElement("guid").setText(item.guid).setAttribute("isPermaLink", "false"));
    el.addContent(XmlService.createElement("description").addContent(XmlService.createCdata(item.description)));
    if (item.kategorie) el.addContent(XmlService.createElement("category").setText(item.kategorie));
    el.addContent(XmlService.createElement("pubDate").setText(item.pubDate));
    chanEl.addContent(el);
  });

  var rssXml = XmlService.getPrettyFormat().format(XmlService.createDocument(rssEl));

  // --- Log aufbauen ---
  var logText = [
    "=== VERANSTALTUNGEN-FEED PROTOKOLL ===",
    "Start: " + now.toLocaleString("de-CH"),
    "Regeln: max. " + MAX_REISEZEIT_MIN + " min ab Morges (Ausnahmen: " + Object.keys(AUSNAHME_ORTE).join(", ") + "), max. " + MAX_LAUFZEIT_TAGE + " Tage Laufzeit",
    "Bedeutung: " + RANG_SCHWELLEN.map(function(r) {
      return (r.bisMinuten === Infinity ? "darueber" : "bis " + r.bisMinuten + " min") + " -> Rang " + r.maxRang;
    }).join(", "),
    "",
    "Feeds:\n" + feedUrls.map(function(u) { return "- " + u; }).join("\n"),
    "",
    "Kein Link (ignoriert):",
    noLinkLog.length > 0 ? noLinkLog.join("\n") : "- Keine.",
    "",
    "Statischer Filter (Keywords):",
    staticLog.length > 0 ? staticLog.join("\n") : "- Keine.",
    "",
    "Aus Cache uebernommen (" + cacheLog.length + "):",
    cacheLog.length > 0 ? cacheLog.join("\n") : "- Keine.",
    "",
    "KI-Filter / Cache-Loeschungen (" + aiLog.length + "):",
    aiLog.length > 0 ? aiLog.join("\n") : "- Keine.",
    "",
    "Regelfilter Datum/Entfernung/Dauerausstellung (" + regelLog.length + "):",
    regelLog.length > 0 ? regelLog.join("\n") : "- Keine.",
    "",
    "Ohne KI-Daten uebernommen (" + ohneMetaLog.length + "):",
    ohneMetaLog.length > 0 ? ohneMetaLog.join("\n") : "- Keine.",
    "",
    "Finale Liste (" + allItems.length + " Eintraege):",
    finalLog.length > 0 ? finalLog.join("\n") : "- Feed ist leer."
  ].join("\n");

  // --- GitHub Upload ---
  if (props.githubToken) {
    log("=== GITHUB UPLOAD ===");
    // Notbremse: ein leerer Feed ist nie ein gueltiges Ergebnis, sondern immer
    // ein Ausfall weiter oben. Dann bleibt die bisherige Datei stehen - das
    // Protokoll wird trotzdem geschrieben, damit die Ursache sichtbar ist.
    if (allItems.length === 0) {
      Logger.log("[UPLOAD ABGEBROCHEN] 0 Eintraege - bisheriger Feed bleibt unveraendert.");
      logText += "\n\nUPLOAD ABGEBROCHEN: 0 Eintraege. Die bisherige veranstaltungen.xml bleibt stehen.";
    } else {
      githubPutFile(c.owner, c.repo, props.githubToken, c.xmlPath,
        rssXml, "Auto-Update: Veranstaltungen Feed");
    }
    githubPutFile(c.owner, c.repo, props.githubToken,
      c.xmlPath.replace(/\.xml$/i, "") + ".log",
      logText, "Auto-Update: Veranstaltungen Log");
  } else {
    log("[GITHUB] Kein Token - Upload uebersprungen.");
  }

  log("=== FERTIG: " + allItems.length + " Artikel im Feed ===");
}
