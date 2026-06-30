'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'data', 'session.json');
const GO_HOLD_MS = 1500;
const COUNTDOWN_MS = 5000;

function createRunner() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function assert(name, condition, detail = '') {
    if (condition) {
      passed += 1;
      console.log(`  ✓ ${name}`);
      return;
    }
    failed += 1;
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }

  function summary() {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    return { passed, failed, failures, ok: failed === 0 };
  }

  return { assert, summary, get counts() { return { passed, failed, failures }; } };
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

function openWs(port, role) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

function backupSessionFile() {
  if (fs.existsSync(SESSION_FILE)) return fs.readFileSync(SESSION_FILE, 'utf8');
  return null;
}

function restoreSessionFile(backup) {
  if (backup == null) {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    return;
  }
  fs.writeFileSync(SESSION_FILE, backup);
}

function makeTeam(overrides = {}) {
  return {
    id: 9001,
    name: 'Test Squad',
    category: 'gemengd',
    members: ['m', 'm', 'm', 'm'],
    verkleed: false,
    demeritPoints: 0,
    demeritsConfirmed: false,
    totalTime: 0,
    status: 'pending',
    runStartTime: 0,
    finishedAt: 0,
    ...overrides,
  };
}

function idleSession(teams = []) {
  return {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    demeritSecondsPerPoint: 10,
    teams,
  };
}

module.exports = {
  SESSION_FILE,
  GO_HOLD_MS,
  COUNTDOWN_MS,
  createRunner,
  httpGet,
  openWs,
  waitForSession,
  sendUpdate,
  sleep,
  backupSessionFile,
  restoreSessionFile,
  makeTeam,
  idleSession,
};
