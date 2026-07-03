'use strict';

/**
 * Go-Kart Remastered — lokale race-server
 *
 * Synchroniseert display, administrator en wedstrijdleider via WebSocket.
 * Sessie wordt in geheugen gehouden en opgeslagen in data/session.json.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');
const { publicDir, sessionFile } = require('./scripts/paths');

const PORT = Number(process.env.PORT) || 8765;
const PUBLIC_DIR = publicDir();
const SESSION_FILE = sessionFile();

/** F1-aftelling in seconden voordat de GO-fase start. */
const COUNTDOWN_SEC = 5;
/** GO-fase duur in ms (groene lichten) vóór de run start. */
const GO_HOLD_MS = 1500;
/** Standaard boeteseconden per taakstrafpunt (aanpasbaar via setup). */
const DEFAULT_DEMERIT_SEC_PER_POINT = 10;

/** Alle verbonden WebSocket-clients. */
const clients = [];

/** Live racesessie — bron van waarheid voor alle schermen. */
let session = emptySession();
/** Snapshot vóór laatste Start / GO / Afronden (alleen wedstrijdleider kan terugdraaien). */
let undoSnapshot = null;

/**
 * @typedef {'IDLE'|'COUNTDOWN'|'RACING'} RaceState
 * @typedef {Object} Session
 * @property {RaceState} raceState
 * @property {number|null} raceStartTime
 * @property {number|null} countdownEnd
 * @property {unknown[]} teams
 * @property {number} demeritSecondsPerPoint — seconds added per task demerit point
 */

function sanitizeDemeritSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEMERIT_SEC_PER_POINT;
  return Math.min(n, 3600);
}

function emptySession() {
  return {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    teams: [],
    demeritSecondsPerPoint: DEFAULT_DEMERIT_SEC_PER_POINT,
  };
}

function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizeSession(raw) {
  const next = {
    raceState: ['IDLE', 'COUNTDOWN', 'RACING'].includes(raw?.raceState) ? raw.raceState : 'IDLE',
    raceStartTime: toMs(raw?.raceStartTime),
    countdownEnd: toMs(raw?.countdownEnd),
    teams: Array.isArray(raw?.teams) ? raw.teams : Array.isArray(raw?.drivers) ? raw.drivers : [],
    demeritSecondsPerPoint: sanitizeDemeritSeconds(raw?.demeritSecondsPerPoint),
  };

  if (next.raceState === 'COUNTDOWN') {
    if (!next.countdownEnd || next.countdownEnd <= Date.now()) {
      next.raceState = 'IDLE';
      next.countdownEnd = null;
    }
  }
  if (next.raceState !== 'RACING') {
    next.raceStartTime = null;
    next.teams.forEach((t) => {
      if (t?.status === 'racing') {
        t.status = 'pending';
        t.runStartTime = 0;
      }
    });
  }
  if (next.raceState === 'IDLE') {
    next.raceStartTime = null;
    next.countdownEnd = null;
  }
  return next;
}

function isUndoableTransition(prev, next) {
  if (prev.raceState === 'IDLE' && next.raceState === 'COUNTDOWN') return true;
  if (prev.raceState === 'COUNTDOWN' && next.raceState === 'RACING') return true;
  if (prev.raceState === 'RACING' && next.raceState === 'IDLE') return true;
  return false;
}

function nextPendingTeam(teams) {
  return teams.find((t) => t?.status === 'pending') ?? null;
}

function mergeForRole(incoming, role) {
  const data = sanitizeSession(incoming);
  // Display mag nooit de racestatus wijzigen.
  if (role === 'display') return null;
  // Wedstrijdleider heeft volledige timing-autoriteit.
  if (role === 'control') return data;
  // Administrator en setup mogen alleen teams beheren, niet de timer.
  if (role === 'manager' || role === 'home') {
    return {
      raceState: session.raceState,
      raceStartTime: session.raceStartTime,
      countdownEnd: session.countdownEnd,
      teams: data.teams,
    };
  }
  return null;
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) client.send(text);
  }
}

function sendSession(ws) {
  ws.send(JSON.stringify({ type: 'session', session: sessionPayload() }));
}

function sessionPayload() {
  return { ...session, undoSnapshot, serverTime: Date.now() };
}

function broadcastTimeSync() {
  const text = JSON.stringify({ type: 'time', serverTime: Date.now() });
  for (const client of clients) {
    if (client.readyState === 1) client.send(text);
  }
}

function saveSessionToDisk() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionPayload(), null, 2));
  } catch (err) {
    console.warn('Could not save session:', err.message);
  }
}

function loadSessionFromDisk() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    undoSnapshot = raw?.undoSnapshot ? sanitizeSession(raw.undoSnapshot) : null;
    const { undoSnapshot: _drop, ...rest } = raw ?? {};
    session = sanitizeSession(rest);
  } catch (err) {
    console.warn('Could not load session:', err.message);
  }
}

function snapshotForUndo() {
  return sanitizeSession({
    raceState: session.raceState,
    raceStartTime: session.raceStartTime,
    countdownEnd: session.countdownEnd,
    teams: JSON.parse(JSON.stringify(session.teams)),
  });
}

function applyUndo() {
  if (!undoSnapshot) return false;
  const demeritSecondsPerPoint = session.demeritSecondsPerPoint;
  let restored = sanitizeSession(undoSnapshot);
  if (restored.raceState === 'COUNTDOWN') {
    restored = { ...restored, raceState: 'IDLE', countdownEnd: null };
  }
  if (restored.raceState === 'IDLE') {
    restored.raceStartTime = null;
    restored.teams.forEach((t) => {
      if (t?.status === 'racing') {
        t.status = 'pending';
        t.runStartTime = 0;
      }
    });
  }
  session = restored;
  session.demeritSecondsPerPoint = demeritSecondsPerPoint;
  undoSnapshot = null;
  return true;
}

function setSession(next) {
  const demeritSecondsPerPoint = next?.demeritSecondsPerPoint != null
    ? sanitizeDemeritSeconds(next.demeritSecondsPerPoint)
    : session.demeritSecondsPerPoint ?? DEFAULT_DEMERIT_SEC_PER_POINT;
  session = sanitizeSession({ ...next, demeritSecondsPerPoint });
  saveSessionToDisk();
  broadcast({ type: 'session', session: sessionPayload() });
}

function tickCountdown() {
  if (session.raceState !== 'COUNTDOWN' || !session.countdownEnd) return;
  if (Date.now() < session.countdownEnd) return;

  const next = nextPendingTeam(session.teams);
  if (!next) {
    session.raceState = 'IDLE';
    session.countdownEnd = null;
    saveSessionToDisk();
    broadcast({ type: 'session', session: sessionPayload() });
    return;
  }

  undoSnapshot = snapshotForUndo();
  session.raceState = 'RACING';
  session.countdownEnd = null;
  session.raceStartTime = Date.now();
  next.status = 'racing';
  next.runStartTime = session.raceStartTime;
  next.demeritPoints = 0;
  next.demeritsConfirmed = false;
  saveSessionToDisk();
  broadcast({ type: 'session', session: sessionPayload() });
}

function lanAddresses() {
  const addrs = [];
  try {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
      }
    }
  } catch {
    // Some sandboxes block network interface enumeration.
  }
  return addrs;
}

function buildUrls(host = 'localhost') {
  const base = `http://${host}:${PORT}`;
  return {
    setup: base + '/',
    display: base + '/display',
    manager: base + '/manager',
    control: base + '/control',
  };
}

loadSessionFromDisk();

const app = express();

// --- HTTP-routes ---

/** Race-UI alleen met geldige rol; anders terug naar setup. */
app.get('/race.html', (req, res) => {
  const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
  if (mode !== 'display' && mode !== 'manager' && mode !== 'control') {
    return res.redirect('/');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'race.html'));
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/** Korte url's per rol → race.html?mode=… */
for (const mode of ['display', 'manager', 'control']) {
  app.get(`/${mode}`, (_req, res) => {
    res.redirect(`/race.html?mode=${mode}`);
  });
}

app.get('/api/info', (_req, res) => {
  const addresses = lanAddresses();
  const primary = addresses[0] ?? 'localhost';
  res.json({
    port: PORT,
    addresses,
    primaryAddress: primary,
    urls: buildUrls(primary),
    localUrls: buildUrls('localhost'),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- WebSocket: sessie synchroniseren tussen alle schermen ---

wss.on('connection', (ws) => {
  /** @type {'display'|'manager'|'control'|'home'|''} */
  let role = '';

  clients.push(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      role = ['display', 'manager', 'control', 'home'].includes(msg.role) ? msg.role : 'display';
      sendSession(ws);
      return;
    }

    if (msg.type === 'reset') {
      if (role !== 'manager' && role !== 'home') return;
      const demeritSecondsPerPoint = session.demeritSecondsPerPoint;
      session = emptySession();
      session.demeritSecondsPerPoint = demeritSecondsPerPoint;
      undoSnapshot = null;
      saveSessionToDisk();
      broadcast({ type: 'session', session: sessionPayload() });
      return;
    }

    if (msg.type === 'undo') {
      if (role !== 'control') return;
      if (!applyUndo()) return;
      saveSessionToDisk();
      broadcast({ type: 'session', session: sessionPayload() });
      return;
    }

    if (msg.type === 'load') {
      if (role !== 'manager' && role !== 'home') return;
      if (session.raceState === 'RACING' || session.raceState === 'COUNTDOWN') return;
      undoSnapshot = null;
      setSession(msg.session);
      return;
    }

    if (msg.type === 'updateSettings') {
      if (role !== 'home' && role !== 'manager') return;
      session.demeritSecondsPerPoint = sanitizeDemeritSeconds(msg.demeritSecondsPerPoint);
      saveSessionToDisk();
      broadcast({ type: 'session', session: sessionPayload() });
      return;
    }

    if (msg.type === 'update') {
      const merged = mergeForRole(msg.session, role);
      if (!merged) return;
      if (role === 'control') {
        if (session.raceState === 'IDLE' && merged.raceState === 'COUNTDOWN') {
          merged.countdownEnd = Date.now() + COUNTDOWN_SEC * 1000 + GO_HOLD_MS;
        }
        if (session.raceState === 'COUNTDOWN' && merged.raceState === 'RACING') {
          if (session.countdownEnd && Date.now() < session.countdownEnd) {
            merged.raceState = 'COUNTDOWN';
            merged.raceStartTime = null;
            merged.countdownEnd = session.countdownEnd;
            merged.teams = JSON.parse(JSON.stringify(session.teams));
          }
        }
        if (msg.undoBefore) {
          undoSnapshot = sanitizeSession(msg.undoBefore);
        } else if (isUndoableTransition(session, merged)) {
          undoSnapshot = snapshotForUndo();
        }
      }
      setSession(merged);
    }
  });

  ws.on('close', () => {
    const idx = clients.indexOf(ws);
    if (idx >= 0) clients.splice(idx, 1);
  });
});

let lastTimeSync = 0;
setInterval(() => {
  tickCountdown();
  if (session.raceState === 'COUNTDOWN' || session.raceState === 'RACING') {
    const now = Date.now();
    if (now - lastTimeSync >= 1000) {
      lastTimeSync = now;
      broadcastTimeSync();
    }
  } else {
    lastTimeSync = 0;
  }
}, 50);

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  Go-Kart Remastered — race server running\n');
  console.log(`  Setup:            http://localhost:${PORT}/`);
  console.log(`  Host display:     http://localhost:${PORT}/display`);
  console.log(`  Administrator:    http://localhost:${PORT}/manager`);
  console.log(`  Wedstrijdleider:  http://localhost:${PORT}/control`);
  console.log('');
  if (addrs.length) {
    console.log('  On your local network (share with laptop & iPad):');
    for (const ip of addrs) {
      console.log(`    Display:  http://${ip}:${PORT}/display`);
      console.log(`    Administrator:  http://${ip}:${PORT}/manager`);
      console.log(`    Wedstrijdleider:  http://${ip}:${PORT}/control`);
      console.log('');
    }
  } else {
    console.log('  (No LAN IP found — use localhost URLs on this machine.)\n');
  }
});
