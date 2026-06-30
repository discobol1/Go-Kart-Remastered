'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 9876;
const LOG_PATH = path.join(__dirname, '..', '.cursor', 'debug-dfbd3b.log');
const SESSION_FILE = path.join(__dirname, '..', 'data', 'session.json');
const GO_HOLD_MS = 1500;
const COUNTDOWN_MS = 5000;

let passed = 0;
let failed = 0;
const failures = [];

function log(message, data = {}, hypothesisId = 'TEST') {
  const entry = {
    sessionId: 'dfbd3b',
    timestamp: Date.now(),
    location: 'integration-test.js',
    message,
    data,
    hypothesisId,
    runId: 'integration',
  };
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // ignore
  }
}

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    log(`PASS: ${name}`, { detail });
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  failures.push({ name, detail });
  log(`FAIL: ${name}`, { detail }, 'FAIL');
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function openWs(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timeout = setTimeout(() => reject(new Error(`WS timeout (${role})`)), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role }));
    });
    ws.on('message', (raw) => {
      clearTimeout(timeout);
      const msg = JSON.parse(String(raw));
      if (msg.type === 'session') resolve({ ws, session: msg.session });
    });
    ws.on('error', reject);
  });
}

function waitForSession(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('waitForSession timeout')), timeoutMs);
    const handler = (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== 'session') return;
      if (predicate(msg.session)) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg.session);
      }
    };
    ws.on('message', handler);
  });
}

function sendUpdate(ws, session, extra = {}) {
  ws.send(JSON.stringify({ type: 'update', session, ...extra }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backupSession() {
  if (fs.existsSync(SESSION_FILE)) {
    return fs.readFileSync(SESSION_FILE, 'utf8');
  }
  return null;
}

function restoreSession(backup) {
  if (backup == null) {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    return;
  }
  fs.writeFileSync(SESSION_FILE, backup);
}

async function runTests() {
  console.log('\nGo-Kart Pro — integration tests\n');

  // HTTP
  const home = await httpGet(`http://127.0.0.1:${PORT}/`);
  assert('GET / returns 200', home.status === 200);

  const display = await httpGet(`http://127.0.0.1:${PORT}/display`);
  assert('GET /display redirects', display.status === 302 && display.headers.location?.includes('race.html?mode=display'));

  const api = await httpGet(`http://127.0.0.1:${PORT}/api/info`);
  const info = JSON.parse(api.body);
  assert('GET /api/info has urls', info.urls?.manager && info.urls?.control);

  const race = await httpGet(`http://127.0.0.1:${PORT}/race.html`);
  assert('GET /race.html returns 200', race.status === 200);
  assert('race.html has GO_HOLD_MS', race.body.includes('GO_HOLD_MS'));
  assert('race.html has setF1Lights', race.body.includes('function setF1Lights'));

  // Reset via manager
  const mgr = await openWs('manager');
  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  let session = await waitForSession(mgr.ws, (s) => s.raceState === 'IDLE' && s.teams.length === 0);
  assert('Manager reset clears session', session.teams.length === 0);

  // Add team
  const team = {
    id: 9001,
    name: 'Test Squad',
    category: 'gemengd',
    members: ['m', 'm', 'm', 'm'],
    verkleed: false,
    totalTime: 0,
    status: 'pending',
    runStartTime: 0,
    finishedAt: 0,
  };
  sendUpdate(mgr.ws, {
    raceState: session.raceState,
    raceStartTime: session.raceStartTime,
    countdownEnd: session.countdownEnd,
    teams: [team],
  });
  session = await waitForSession(mgr.ws, (s) => s.teams.length === 1);
  assert('Manager can add team', session.teams[0]?.name === 'Test Squad');

  // Display cannot update race state
  const displayWs = await openWs('display');
  sendUpdate(displayWs.ws, {
    raceState: 'RACING',
    raceStartTime: Date.now(),
    countdownEnd: null,
    teams: session.teams,
  });
  await sleep(200);
  const ctrlCheck = await openWs('control');
  assert('Display cannot change race state', ctrlCheck.session.raceState === 'IDLE');
  ctrlCheck.ws.close();

  // Control starts countdown (with GO hold window)
  const control = await openWs('control');
  const countdownEnd = Date.now() + COUNTDOWN_MS + GO_HOLD_MS;
  sendUpdate(control.ws, {
    raceState: 'COUNTDOWN',
    raceStartTime: null,
    countdownEnd,
    teams: session.teams,
  }, { undoBefore: {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    teams: JSON.parse(JSON.stringify(session.teams)),
  } });
  session = await waitForSession(control.ws, (s) => s.raceState === 'COUNTDOWN');
  assert('Control starts countdown', session.raceState === 'COUNTDOWN' && session.countdownEnd === countdownEnd);
  assert('Undo snapshot stored on start', session.undoSnapshot != null, JSON.stringify(session.undoSnapshot?.raceState));

  // Server tick -> RACING after full countdown + hold
  session = await waitForSession(control.ws, (s) => s.raceState === 'RACING', COUNTDOWN_MS + GO_HOLD_MS + 3000);
  assert('Server transitions to RACING after countdown', session.raceState === 'RACING');
  assert('Team is racing', session.teams.find((t) => t.id === 9001)?.status === 'racing');

  // Finish run
  const racingTeam = session.teams.find((t) => t.id === 9001);
  racingTeam.status = 'finished';
  racingTeam.totalTime = 42.5;
  racingTeam.finishedAt = Date.now();
  sendUpdate(control.ws, {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    teams: session.teams,
  });
  session = await waitForSession(control.ws, (s) => s.raceState === 'IDLE' && s.teams[0]?.status === 'finished');
  assert('Control finishes run', session.teams[0]?.status === 'finished');

  // Undo finish
  control.ws.send(JSON.stringify({ type: 'undo' }));
  session = await waitForSession(control.ws, (s) => s.teams[0]?.status === 'racing');
  assert('Undo restores racing team', session.teams[0]?.status === 'racing' && session.raceState === 'RACING');

  // Manager cannot undo
  mgr.ws.send(JSON.stringify({ type: 'undo' }));
  await sleep(300);
  sendUpdate(mgr.ws, { raceState: session.raceState, raceStartTime: session.raceStartTime, countdownEnd: session.countdownEnd, teams: session.teams });
  await sleep(300);
  assert('Manager undo ignored', session.raceState === 'RACING');

  // Reset cleanup
  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  await waitForSession(mgr.ws, (s) => s.teams.length === 0);

  mgr.ws.close();
  control.ws.close();
  displayWs.ws.close();

  // Session file persistence
  assert('Session file exists on disk', fs.existsSync(SESSION_FILE));
  const disk = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  assert('Disk session is IDLE after reset', disk.raceState === 'IDLE');

  log('integration complete', { passed, failed, failures });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

async function main() {
  const sessionBackup = backupSession();

  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server failed to start')), 8000);
    server.stdout.on('data', (buf) => {
      if (String(buf).includes('race server running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.stderr.on('data', (buf) => console.error(String(buf)));
    server.on('error', reject);
  });

  let ok = false;
  try {
    ok = await runTests();
  } finally {
    server.kill('SIGTERM');
    restoreSession(sessionBackup);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
