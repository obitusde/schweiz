// AP Badging — Service Worker
// Handles: offline caching, state persistence via IndexedDB, scheduled notifications

const CACHE = 'ap-badging-v1';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

let timers = {};

// ── LIFECYCLE ──────────────────────────────────────────────────────────────

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
      .then(() => loadStateFromIDB().then(s => { if (s) scheduleAll(s); }))
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request)
      .then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});

// ── MESSAGES FROM MAIN THREAD ──────────────────────────────────────────────

self.addEventListener('message', e => {
  if (e.data?.type === 'STATE_UPDATE') {
    saveStateToIDB(e.data.state).then(() => scheduleAll(e.data.state));
  }
});

// ── NOTIFICATION CLICK ─────────────────────────────────────────────────────

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const open = cs.find(c => c.url.includes('index.html') || c.url.endsWith('/'));
      if (open) return open.focus();
      return clients.openWindow('./');
    })
  );
});

// ── INDEXEDDB HELPERS ──────────────────────────────────────────────────────

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('ap-badging-db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => res(e.target.result);
    req.onerror = rej;
  });
}

function saveStateToIDB(state) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(state, 'state');
    tx.oncomplete = res;
    tx.onerror = rej;
  })).catch(() => {});
}

function loadStateFromIDB() {
  return openDB().then(db => new Promise(res => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get('state');
    req.onsuccess = e => res(e.target.result || null);
    req.onerror = () => res(null);
  })).catch(() => null);
}

// ── NOTIFICATION SCHEDULING ────────────────────────────────────────────────

function isTodayDifferent(state) {
  if (!state?.letzterTag) return true;
  return state.letzterTag !== new Date().toDateString();
}

function clearTimers() {
  Object.values(timers).forEach(clearTimeout);
  timers = {};
}

function notify(title, body, tag) {
  return self.registration.showNotification(title, {
    body,
    icon: './icon.svg',
    tag,
    renotify: true,
    actions: [{ action: 'open', title: 'Öffnen' }]
  });
}

function scheduleAll(state) {
  clearTimers();

  const now = Date.now();
  const d = new Date();
  const todayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  // ms until a given time today / tomorrow
  const today    = (h, m) => todayMs + h * 3600000 + m * 60000 - now;
  const tomorrow = (h, m) => todayMs + 86400000 + h * 3600000 + m * 60000 - now;

  // Effective status for today (if stored state is from yesterday, treat as BEREIT)
  const status   = isTodayDifferent(state) ? 'BEREIT' : (state.status   || 'BEREIT');
  const pauseMin = isTodayDifferent(state) ? 0        : (state.realePauseMinuten || 0);

  // ── 08:00 Kommen-Erinnerung ────────────────────────────────────────────
  if (status === 'BEREIT') {
    const ms = today(8, 0);
    if (ms > 0) {
      timers.kommen = setTimeout(() => {
        loadStateFromIDB().then(s => {
          const eff = isTodayDifferent(s) ? 'BEREIT' : (s?.status || 'BEREIT');
          if (eff === 'BEREIT') notify('⏰ Eingestempelt?',
            'Es ist 08:00 Uhr — hast du vergessen einzustempeln?', 'kommen');
        });
      }, ms);
    }
  }

  // ── 12:30 Mittagspause-Erinnerung ─────────────────────────────────────
  if (status === 'ARBEIT' && pauseMin === 0) {
    const ms = today(12, 30);
    if (ms > 0) {
      timers.mittag = setTimeout(() => {
        loadStateFromIDB().then(s => {
          if (!isTodayDifferent(s) && s?.status === 'ARBEIT' && !(s?.realePauseMinuten > 0))
            notify('🍽️ Mittagspause?',
              'Es ist 12:30 Uhr — noch keine Pause eingetragen.', 'mittag');
        });
      }, ms);
    }
  }

  // ── 13:30 Pause beenden ────────────────────────────────────────────────
  if (status === 'PAUSE') {
    const ms = today(13, 30);
    if (ms > 0) {
      timers.pauseEnde = setTimeout(() => {
        loadStateFromIDB().then(s => {
          if (!isTodayDifferent(s) && s?.status === 'PAUSE')
            notify('⚠️ Pause beenden!',
              'Es ist 13:30 Uhr — du bist noch in der Mittagspause.', 'pauseEnde');
        });
      }, ms);
    }
  }

  // ── 18:00 Feierabend-Erinnerung ────────────────────────────────────────
  if (status === 'ARBEIT' || status === 'PAUSE') {
    const ms = today(18, 0);
    if (ms > 0) {
      timers.feierabend = setTimeout(() => {
        loadStateFromIDB().then(s => {
          if (!isTodayDifferent(s) && (s?.status === 'ARBEIT' || s?.status === 'PAUSE'))
            notify('🏠 Feierabend!',
              'Es ist 18:00 Uhr — vergiss nicht auszustempeln!', 'feierabend');
        });
      }, ms);
    }
  }

  // ── Morgen 08:00 Kommen-Erinnerung ─────────────────────────────────────
  // Scheduled when today is done (BEENDET) or 08:00 already passed without clock-in
  const past0800 = today(8, 0) <= 0;
  if (status === 'BEENDET' || (status === 'BEREIT' && past0800)) {
    const ms = tomorrow(8, 0);
    if (ms > 0) {
      timers.kommenMorgen = setTimeout(() => {
        loadStateFromIDB().then(s => {
          const eff = isTodayDifferent(s) ? 'BEREIT' : (s?.status || 'BEREIT');
          if (eff === 'BEREIT') notify('⏰ Eingestempelt?',
            'Es ist 08:00 Uhr — hast du vergessen einzustempeln?', 'kommen');
        });
      }, ms);
    }
  }
}
