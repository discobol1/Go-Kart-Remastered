'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8765;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_FILE = path.join(__dirname, 'data', 'session.json');

const COUNTDOWN_SEC = 5;

/** @type {import('ws').WebSocket[]} */
const clients = [];

/** @type {Session} */
let session = emptySession();

/**
 * @typedef {'IDLE'|'COUNTDOWN'|'RACING'} RaceState
 * @typedef {Object} Session
 * @property {RaceState} raceState
 * @property {number|null} raceStartTime
 * @property {number|null} countdownEnd
 * @property {unknown[]} teams
 */

function emptySession() {
  return {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    teams: [],
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

function nextPendingTeam(teams) {
  return teams.find((t) => t?.status === 'pending') ?? null;
}

function mergeForRole(incoming, role) {
  const data = sanitizeSession(incoming);
  if (role === 'display') return null;
  if (role === 'control') return data;
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
  ws.send(JSON.stringify({ type: 'session', session }));
}

function saveSessionToDisk() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch (err) {
    console.warn('Could not save session:', err.message);
  }
}

function loadSessionFromDisk() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    session = sanitizeSession(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
  } catch (err) {
    console.warn('Could not load session:', err.message);
  }
}

function setSession(next) {
  session = sanitizeSession(next);
  saveSessionToDisk();
  broadcast({ type: 'session', session });
}

function tickCountdown() {
  if (session.raceState !== 'COUNTDOWN' || !session.countdownEnd) return;
  if (Date.now() < session.countdownEnd) return;

  const next = nextPendingTeam(session.teams);
  if (!next) {
    session.raceState = 'IDLE';
    session.countdownEnd = null;
    saveSessionToDisk();
    broadcast({ type: 'session', session });
    return;
  }

  session.raceState = 'RACING';
  session.countdownEnd = null;
  session.raceStartTime = Date.now();
  next.status = 'racing';
  next.runStartTime = session.raceStartTime;
  saveSessionToDisk();
  broadcast({ type: 'session', session });
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
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

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
      session = emptySession();
      saveSessionToDisk();
      broadcast({ type: 'session', session });
      return;
    }

    if (msg.type === 'load') {
      if (role !== 'manager' && role !== 'home') return;
      if (session.raceState === 'RACING' || session.raceState === 'COUNTDOWN') return;
      setSession(msg.session);
      return;
    }

    if (msg.type === 'update') {
      const merged = mergeForRole(msg.session, role);
      if (!merged) return;
      setSession(merged);
    }
  });

  ws.on('close', () => {
    const idx = clients.indexOf(ws);
    if (idx >= 0) clients.splice(idx, 1);
  });
});

setInterval(tickCountdown, 50);

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('\n  Go-Kart Pro — race server running\n');
  console.log(`  Setup:            http://localhost:${PORT}/`);
  console.log(`  Host display:     http://localhost:${PORT}/display`);
  console.log(`  Race manager:     http://localhost:${PORT}/manager`);
  console.log(`  Race official:    http://localhost:${PORT}/control`);
  console.log('');
  if (addrs.length) {
    console.log('  On your local network (share with laptop & iPad):');
    for (const ip of addrs) {
      console.log(`    Display:  http://${ip}:${PORT}/display`);
      console.log(`    Manager:  http://${ip}:${PORT}/manager`);
      console.log(`    Official: http://${ip}:${PORT}/control`);
      console.log('');
    }
  } else {
    console.log('  (No LAN IP found — use localhost URLs on this machine.)\n');
  }
});
