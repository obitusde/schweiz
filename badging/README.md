# Royal Oak Arbeitszeit — PWA Setup

Eine PWA (Progressive Web App), die auf dem Pixel 8 wie eine native App funktioniert.
Erinnert morgens automatisch, falls noch nicht eingestempelt wurde.

## Architektur

```
+-------------------------+         +--------------------------+
|  GitHub Pages           |         |  Google Apps Script      |
|  (Frontend, PWA)        | <-----> |  (Backend, Datenspeicher)|
|  index.html             |  fetch  |  Code.gs                 |
|  service-worker.js      |  JSON   |                          |
|  manifest.json          |         |                          |
+-------------------------+         +--------------------------+
            ^
            |
       Pixel 8
   (Chrome -> "Zum Startbildschirm hinzufügen")
```

## Deployment (einmalig)

### Teil 1 — Backend (Google Apps Script)

1. Öffne dein bestehendes Apps Script Projekt (script.google.com).
2. Ersetze den Inhalt von `Code.gs` mit dem neuen `Code.gs`.
3. **Deploy → Manage deployments → Edit (Stift) → New version → Deploy**
4. Stelle sicher:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Kopiere die **Web app URL** (endet auf `/exec`).

### Teil 2 — Frontend (GitHub Pages)

1. Öffne `index.html` und ersetze ganz oben:
   ```js
   const API_URL = "PASTE_YOUR_APPS_SCRIPT_DEPLOYMENT_URL_HERE";
   ```
   mit deiner kopierten URL aus Teil 1.

2. Lade folgende Dateien in deinen GitHub-Ordner `schweiz/badging/`:
   - `index.html`
   - `manifest.json`
   - `service-worker.js`
   - `icon-192.png`
   - `icon-512.png`
   - `icon-512-maskable.png`

3. **GitHub Pages aktivieren:**
   - Repo → Settings → Pages
   - Source: **Deploy from a branch**
   - Branch: **main**, Folder: **/ (root)**
   - Save

4. Nach 1-2 Minuten ist die App erreichbar unter:
   **`https://obitusde.github.io/schweiz/badging/`**

### Teil 3 — Auf Pixel 8 installieren

1. Öffne die URL oben in **Chrome** auf dem Pixel 8.
2. Tippe oben rechts auf das **3-Punkte-Menü** → **"Zum Startbildschirm hinzufügen"** (oder "App installieren").
3. Beim ersten Öffnen → **Benachrichtigungen erlauben** antippen.

Das App-Icon erscheint jetzt im App-Drawer wie eine normale App.

## Erinnerungs-Logik

- Jeden Werktag um **09:00 Uhr** (konfigurierbar in `index.html` via `REMINDER_HOUR`)
- Nur wenn Status noch `BEREIT` ist (also noch nicht eingestempelt)
- Keine Erinnerung am Wochenende
- Benachrichtigung erscheint auch bei geschlossener App

## Wichtige Einschränkungen

Hintergrund-Service-Worker sind auf Android **nicht 100% zuverlässig** — Chrome darf den Worker zur Akku-Schonung beenden. In der Praxis funktioniert das gut, wenn:
- Die App regelmäßig benutzt wird (Chrome lässt den SW dann länger leben)
- Die App von den Akku-Sparoptionen ausgenommen wird (Einstellungen → Apps → Chrome → Akku → Uneingeschränkt)

Wenn 100% Zuverlässigkeit gefordert ist, kann später ein zeitgesteuerter Apps-Script-Trigger + ntfy.sh ergänzt werden — sag Bescheid.

## Aktualisieren

Wenn du eine neue Version pushst:
- Backend: in Apps Script neue Version deployen (URL bleibt gleich, wenn du "Edit deployment" benutzt)
- Frontend: einfach Dateien auf GitHub ersetzen. Die App lädt die neue Version beim nächsten Öffnen automatisch (durch Cache-Versioning im Service Worker).

Wenn der Cache sich "stuck" anfühlt: in Chrome lange auf das App-Icon → "App-Info" → "Speicher" → "Cache leeren".
