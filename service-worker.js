// =============================================================
// Royal Oak Arbeitszeit — Service Worker
// =============================================================
// Handles:
//   1. Offline app shell caching
//   2. Periodic background sync to check badge status
//   3. Displaying notifications when reminders are due
// =============================================================

const CACHE_VERSION = 'v1';
const CACHE_NAME = `royal-oak-${CACHE_VERSION}`;
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// =============================================================
// Install — cache the app shell
// =============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// =============================================================
// Activate — clean up old caches
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
// Fetch — cache-first for the app shell only
// API calls to Apps Script always go to network
// =============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Apps Script API calls — always fresh
  if (url.hostname.includes('googleusercontent.com') ||
      url.hostname.includes('script.google.com')) {
    return; // let it pass through normally
  }

  // Cache-first for our own shell files
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful GETs for next time
        if (event.request.method === 'GET' && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // fallback to cached if available
    })
  );
});

// =============================================================
// Periodic background sync — fires roughly daily
// Checks if the user still needs to badge in today
// =============================================================
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-badge-status') {
    event.waitUntil(checkAndRemind());
  }
});

// Regular background sync as fallback (triggered manually from page)
self.addEventListener('sync', (event) => {
  if (event.tag === 'check-badge-status') {
    event.waitUntil(checkAndRemind());
  }
});

// =============================================================
// Manual reminder check — triggered by message from page
// (most reliable mechanism — runs when the page calls it)
// =============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_REMINDER') {
    event.waitUntil(checkAndRemind(event.data.apiUrl));
  }
  if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
    // Schedule a notification at a specific future time
    scheduleReminder(event.data.fireAtMs, event.data.apiUrl);
  }
});

// =============================================================
// Core reminder logic
// =============================================================
async function getApiUrl() {
  // Stored in cache as a tiny config blob — set on first page load
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match('config-api-url');
    if (res) return await res.text();
  } catch (e) { /* ignore */ }
  return null;
}

async function checkAndRemind(apiUrlOverride) {
  const apiUrl = apiUrlOverride || (await getApiUrl());
  if (!apiUrl) return;

  // Don't remind on weekends
  const day = new Date().getDay();
  if (day === 0 || day === 6) return;

  // Only remind during morning hours
  const hour = new Date().getHours();
  if (hour < 7 || hour > 11) return;

  try {
    const dateStr = new Date().toDateString();
    const url = `${apiUrl}?action=checkReminder&date=${encodeURIComponent(dateStr)}`;
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
    // Silent fail — we'll try again next sync
  }
}

// =============================================================
// Local timer-based reminder (fires while SW is alive)
// =============================================================
let reminderTimer = null;
function scheduleReminder(fireAtMs, apiUrl) {
  if (reminderTimer) clearTimeout(reminderTimer);
  const delay = fireAtMs - Date.now();
  if (delay <= 0) {
    checkAndRemind(apiUrl);
    return;
  }
  // setTimeout in a service worker is best-effort —
  // browser may kill the worker before it fires
  reminderTimer = setTimeout(() => checkAndRemind(apiUrl), delay);
}

// =============================================================
// Notification click — focus or open the app
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
