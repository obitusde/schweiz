// =============================================================
// Royal Oak Arbeitszeit — Apps Script Backend
// =============================================================
// This file lives in Google Apps Script (script.google.com)
// The frontend (index.html) is now hosted on GitHub Pages and
// talks to this backend via JSON over HTTPS.
// =============================================================

const SOLL_STUNDEN = 8;
const SOLL_MINUTEN = 25;

// =============================================================
// JSON API entry point — handles ALL requests from the PWA
// =============================================================
function doGet(e) {
  let result;
  try {
    const action = (e && e.parameter && e.parameter.action) || 'status';
    const clientDate = (e && e.parameter && e.parameter.date) || new Date().toDateString();

    if (action === 'status') {
      result = getHeutigenStatus(clientDate);
    }
    else if (action === 'stempeln') {
      const type = e.parameter.type;
      const pause = parseInt(e.parameter.pause, 10) || 45;
      result = stempeln(type, pause, clientDate);
    }
    else if (action === 'updatePause') {
      const pause = parseInt(e.parameter.pause, 10) || 45;
      result = updatePauseInScript(pause, clientDate);
    }
    else if (action === 'reset') {
      result = komplettReset();
    }
    else if (action === 'checkReminder') {
      // Used by the background reminder check — returns just the boolean
      // "should we remind the user?"
      result = checkReminderNeeded(clientDate);
    }
    else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// =============================================================
// Storage helpers
// =============================================================
function getStorage() {
  return PropertiesService.getUserProperties();
}

function getHeutigenStatus(clientHeuteStr) {
  const props = getStorage();
  const heuteStr = clientHeuteStr || new Date().toDateString();
  const gespeicherterTag = props.getProperty('LETZTER_TAG');

  if (gespeicherterTag !== heuteStr) {
    return {
      status: 'BEREIT',
      kommenZeit: null,
      gehenZeit: null,
      geplantePauseMinuten: 45,
      realePauseMs: 0,
      uiPauseStartZeit: null
    };
  }

  return {
    status: props.getProperty('STATUS') || 'BEREIT',
    kommenZeit: props.getProperty('KOMMEN_ZEIT') ? parseInt(props.getProperty('KOMMEN_ZEIT'), 10) : null,
    gehenZeit: props.getProperty('GEHEN_ZEIT') ? parseInt(props.getProperty('GEHEN_ZEIT'), 10) : null,
    geplantePauseMinuten: props.getProperty('GEPLANTE_PAUSE') ? parseInt(props.getProperty('GEPLANTE_PAUSE'), 10) : 45,
    realePauseMs: props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0,
    uiPauseStartZeit: props.getProperty('UI_PAUSE_START') ? parseInt(props.getProperty('UI_PAUSE_START'), 10) : null
  };
}

// =============================================================
// Actions: Kommen / Pause / Gehen
// =============================================================
function stempeln(aktion, geplantePause, clientHeuteStr) {
  const props = getStorage();
  const heuteStr = clientHeuteStr || new Date().toDateString();
  const jetztMs = new Date().getTime();

  props.setProperty('LETZTER_TAG', heuteStr);
  props.setProperty('GEPLANTE_PAUSE', geplantePause.toString());

  if (aktion === 'KOMMEN') {
    props.setProperty('STATUS', 'ARBEIT');
    props.setProperty('KOMMEN_ZEIT', jetztMs.toString());
    props.setProperty('REALE_PAUSE_MS', '0');
    props.deleteProperty('UI_PAUSE_START');
    props.deleteProperty('GEHEN_ZEIT');
  }
  else if (aktion === 'PAUSE_START') {
    props.setProperty('STATUS', 'PAUSE');
    props.setProperty('UI_PAUSE_START', jetztMs.toString());
  }
  else if (aktion === 'PAUSE_ENDE') {
    const startPauseStr = props.getProperty('UI_PAUSE_START');
    if (!startPauseStr) {
      return { error: 'Kein Pausenstart gefunden. Bitte neu laden.' };
    }
    props.setProperty('STATUS', 'ARBEIT');
    const startPause = parseInt(startPauseStr, 10);
    const bisherigePauseMs = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
    const aktuellePauseMs = jetztMs - startPause;
    props.setProperty('REALE_PAUSE_MS', (bisherigePauseMs + aktuellePauseMs).toString());
    props.deleteProperty('UI_PAUSE_START');
  }
  else if (aktion === 'GEHEN') {
    if (props.getProperty('STATUS') === 'PAUSE') {
      const startPauseStr = props.getProperty('UI_PAUSE_START');
      if (startPauseStr) {
        const startPause = parseInt(startPauseStr, 10);
        const bisherigePauseMs = props.getProperty('REALE_PAUSE_MS') ? parseInt(props.getProperty('REALE_PAUSE_MS'), 10) : 0;
        const aktuellePauseMs = jetztMs - startPause;
        props.setProperty('REALE_PAUSE_MS', (bisherigePauseMs + aktuellePauseMs).toString());
      }
      props.deleteProperty('UI_PAUSE_START');
    }
    props.setProperty('STATUS', 'BEENDET');
    props.setProperty('GEHEN_ZEIT', jetztMs.toString());
  }

  return getHeutigenStatus(heuteStr);
}

function updatePauseInScript(geplanteMinuten, clientHeuteStr) {
  const props = getStorage();
  props.setProperty('GEPLANTE_PAUSE', geplanteMinuten.toString());
  return getHeutigenStatus(clientHeuteStr || new Date().toDateString());
}

function komplettReset() {
  const props = getStorage();
  props.deleteAllProperties();
  return getHeutigenStatus(new Date().toDateString());
}

// =============================================================
// Background reminder check — used by service worker
// Returns whether the user still needs to badge in today
// =============================================================
function checkReminderNeeded(clientHeuteStr) {
  const status = getHeutigenStatus(clientHeuteStr);
  return {
    needsReminder: status.status === 'BEREIT',
    status: status.status
  };
}
