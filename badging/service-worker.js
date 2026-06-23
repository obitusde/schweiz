// =============================================================
// Royal Oak Arbeitszeit — Service Worker
// =============================================================
// Liest alle Einstellungen aus dem Config-Blob, den die Seite
// beim Laden in den Cache schreibt. Hier muss nichts angepasst
// werden — die Config-Werte stehen in index.html.
// =============================================================

const CACHE_VERSION = 'v2';
const CACHE_NAME = `royal-oak-${CACHE_VERSION}`;
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// =============================================================
// Install — App-Shell cachen
// =============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// =============================================================
// Activate — alte Caches aufräumen
// =============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// =============================================================
// Fetch — Cache-First für Shell, Network für API
// =============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Apps Script Aufrufe niemals cachen
  if (url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('script.google.com')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (event.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// =============================================================
// Periodic background sync (best-effort)
// =============================================================
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-badge-status') {
    event.waitUntil(checkAndRemind());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'check-badge-status') {
    event.waitUntil(checkAndRemind());
  }
});

// =============================================================
// Nachrichten von der Seite
// =============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_REMINDER') {
    event.waitUntil(checkAndRemind());
  }
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    scheduleReminder(event.data.fireAtMs);
  }
});

// =============================================================
// Config aus dem Cache lesen
// =============================================================
async function getConfig() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match('config-reminder');
    if (res) return await res.json();
  } catch (e) { /* ignore */ }
  return null;
}

// =============================================================
// Kern-Logik: Status prüfen, ggf. Benachrichtigung anzeigen
// =============================================================
async function checkAndRemind() {
  const config = await getConfig();
  if (!config) return;

  // Erinnerung in Config deaktiviert?
  if (!config.morningActive) return;

  // Wochenende?
  if (!config.weekendActive) {
    const tag = new Date().getDay();
    if (tag === 0 || tag === 6) return;
  }

  if (!config.apiUrl) return;

  try {
    const dateStr = new Date().toDateString();
    const url = `${config.apiUrl}?action=checkReminder&date=${encodeURIComponent(dateStr)}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.needsReminder) {
      await self.registration.showNotification('Stempeln nicht vergessen!', {
        body: 'Du hast heute noch nicht eingestempelt.',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'badge-reminder',
        requireInteraction: true,
        vibrate: [200, 100, 200]
      });
    }
  } catch (err) {
    // Stille — beim nächsten Sync neu versuchen
  }
}

// =============================================================
// Lokaler Timer (best-effort, hält nur solange SW lebt)
// =============================================================
let reminderTimer = null;
function scheduleReminder(fireAtMs) {
  if (reminderTimer) clearTimeout(reminderTimer);
  const delay = fireAtMs - Date.now();
  if (delay <= 0) {
    checkAndRemind();
    return;
  }
  reminderTimer = setTimeout(() => checkAndRemind(), delay);
}

// =============================================================
// Klick auf Notification — App öffnen / fokussieren
// =============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});
