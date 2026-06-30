'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
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
} = require('./test-lib');

const PORT = Number(process.env.TEST_PORT) || 9876;

/** Mirror race.html scoring for unit tests. */
const WOMAN_BONUS_SEC = 5;
const WOMAN_BONUS_MAX_SEC = 15;
const VERKLEED_BONUS_SEC = 10;

function womenCount(team) {
  return (team.members ?? []).filter((m) => m === 'f').length;
}

function womenBonusSec(team) {
  if (team.category !== 'gemengd') return 0;
  return Math.min(womenCount(team) * WOMAN_BONUS_SEC, WOMAN_BONUS_MAX_SEC);
}

function officialFinishTime(team, elapsedSec, demeritSecondsPerPoint) {
  let time = Math.max(0, elapsedSec);
  time = Math.max(0, time - womenBonusSec(team));
  if (team.verkleed) time = Math.max(0, time - VERKLEED_BONUS_SEC);
  time += (team.demeritPoints ?? 0) * demeritSecondsPerPoint;
  return time;
}

async function testHttpAndStatic({ assert, port }) {
  console.log('\n— HTTP & static assets —\n');

  const home = await httpGet(`http://127.0.0.1:${port}/`);
  assert('GET / returns 200', home.status === 200);

  const index = await httpGet(`http://127.0.0.1:${port}/`);
  assert('Setup page has merged race-data-settings', index.body.includes('id="race-data-settings"'));
  assert('Setup page removed separate race-settings section', !index.body.includes('id="race-settings"'));
  assert('Setup page has unlock button', index.body.includes('id="settings-unlock-btn"'));
  assert('Setup page has lock status badge', index.body.includes('id="settings-lock-status"'));
  assert('Setup page has toggleSettingsLock', index.body.includes('function toggleSettingsLock'));
  assert('Setup page verifyPasscode checks unlock state', index.body.includes('if (settingsUnlocked) return true'));
  assert('Setup page disables controls when locked', index.body.includes('el.disabled = !settingsUnlocked'));
  assert('Setup pincode label is Pincode', index.body.includes('>Pincode</label>'));

  const display = await httpGet(`http://127.0.0.1:${port}/display`);
  assert('GET /display redirects', display.status === 302 && display.headers.location?.includes('race.html?mode=display'));

  const manager = await httpGet(`http://127.0.0.1:${port}/manager`);
  assert('GET /manager redirects', manager.status === 302 && manager.headers.location?.includes('mode=manager'));

  const control = await httpGet(`http://127.0.0.1:${port}/control`);
  assert('GET /control redirects', control.status === 302 && control.headers.location?.includes('mode=control'));

  const api = await httpGet(`http://127.0.0.1:${port}/api/info`);
  const info = JSON.parse(api.body);
  assert('GET /api/info has urls', info.urls?.manager && info.urls?.control && info.urls?.display);
  assert('GET /api/info has localUrls', !!info.localUrls?.display);

  const race = await httpGet(`http://127.0.0.1:${port}/race.html`);
  assert('GET /race.html returns 200', race.status === 200);
  assert('race.html has GO_HOLD_MS', race.body.includes('GO_HOLD_MS'));
  assert('race.html has setF1Lights', race.body.includes('function setF1Lights'));
  assert('race.html has manager pending edit panel', race.body.includes('team-item-edit-panel'));
  assert('race.html has managerTogglePendingEdit', race.body.includes('function managerTogglePendingEdit'));
  assert('race.html has renderControlDemeritTimeSummary', race.body.includes('function renderControlDemeritTimeSummary'));
  assert('race.html has getDisplayLiveTitleTeam', race.body.includes('function getDisplayLiveTitleTeam'));
  assert('race.html has womenBonusSec', race.body.includes('function womenBonusSec'));
  assert('race.html has control demerit time summary UI', race.body.includes('control-demerit-time-summary'));
}

function testScoringFormulas({ assert }) {
  console.log('\n— Scoring formulas (race.html logic) —\n');

  const demeritRate = 10;
  assert(
    'Women bonus capped at 15s in gemengd',
    womenBonusSec({ category: 'gemengd', members: ['f', 'f', 'f', 'f'] }) === 15,
  );
  assert(
    'Women bonus 5s per woman in gemengd',
    womenBonusSec({ category: 'gemengd', members: ['f', 'm', 'm', 'm'] }) === 5,
  );
  assert('No women bonus for vrouwen category', womenBonusSec({ category: 'vrouwen', members: ['f', 'f', 'f', 'f'] }) === 0);
  assert('No women bonus for jeugd', womenBonusSec({ category: 'jeugd', members: ['f', 'm'] }) === 0);

  assert(
    'Official time with demerits only',
    officialFinishTime({ category: 'gemengd', members: ['m', 'm', 'm', 'm'], demeritPoints: 2, verkleed: false }, 42.5, demeritRate) === 62.5,
  );
  assert(
    'Official time with women + verkleed bonuses',
    officialFinishTime({ category: 'gemengd', members: ['f', 'f', 'm', 'm'], demeritPoints: 0, verkleed: true }, 50, demeritRate) === 30,
  );
  assert(
    'Official time cannot go below zero',
    officialFinishTime({ category: 'gemengd', members: ['f', 'f', 'f', 'f'], demeritPoints: 0, verkleed: true }, 20, demeritRate) === 0,
  );
}

async function testWsPermissions({ assert, port }) {
  console.log('\n— WebSocket roles & permissions —\n');

  const mgr = await openWs(port, 'manager');
  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  let session = await waitForSession(mgr.ws, (s) => s.raceState === 'IDLE' && s.teams.length === 0);
  assert('Manager reset clears session', session.teams.length === 0);

  const team = makeTeam();
  sendUpdate(mgr.ws, { ...idleSession([team]), teams: [team] });
  session = await waitForSession(mgr.ws, (s) => s.teams.length === 1);
  assert('Manager can add team', session.teams[0]?.name === 'Test Squad');

  const displayWs = await openWs(port, 'display');
  sendUpdate(displayWs.ws, {
    raceState: 'RACING',
    raceStartTime: Date.now(),
    countdownEnd: null,
    teams: session.teams,
  });
  await sleep(200);
  const ctrlCheck = await openWs(port, 'control');
  assert('Display cannot change race state', ctrlCheck.session.raceState === 'IDLE');
  ctrlCheck.ws.close();

  sendUpdate(mgr.ws, {
    raceState: 'RACING',
    raceStartTime: Date.now(),
    countdownEnd: null,
    teams: session.teams,
  });
  await sleep(200);
  const ctrlAfterMgr = await openWs(port, 'control');
  assert('Manager cannot change race state', ctrlAfterMgr.session.raceState === 'IDLE');
  ctrlAfterMgr.ws.close();

  const controlWs = await openWs(port, 'control');
  controlWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 20 }));
  await sleep(200);
  assert('Control cannot updateSettings', controlWs.session.demeritSecondsPerPoint !== 20);
  controlWs.ws.close();

  displayWs.ws.close();
  return { mgr, session, team };
}

async function testDemeritSettings({ assert, port, mgr }) {
  console.log('\n— Demerit settings —\n');

  const homeWs = await openWs(port, 'home');
  homeWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 10 }));
  let session = await waitForSession(homeWs.ws, (s) => s.demeritSecondsPerPoint === 10);
  assert('Home updates demerit seconds per point', session.demeritSecondsPerPoint === 10);

  mgr.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 12 }));
  session = await waitForSession(mgr.ws, (s) => s.demeritSecondsPerPoint === 12);
  assert('Manager can update demerit settings', session.demeritSecondsPerPoint === 12);

  homeWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: -5 }));
  session = await waitForSession(homeWs.ws, (s) => s.demeritSecondsPerPoint === 10);
  assert('Negative demerit setting sanitizes to default 10', session.demeritSecondsPerPoint === 10);

  homeWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 99999 }));
  session = await waitForSession(homeWs.ws, (s) => s.demeritSecondsPerPoint === 3600);
  assert('Demerit setting capped at 3600', session.demeritSecondsPerPoint === 3600);

  homeWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 10 }));
  await waitForSession(homeWs.ws, (s) => s.demeritSecondsPerPoint === 10);
  homeWs.ws.close();
}

async function testRaceLifecycle({ assert, port, mgr, session, team }) {
  console.log('\n— Race lifecycle —\n');

  const control = await openWs(port, 'control');
  const displayWs = await openWs(port, 'display');

  const countdownEnd = Date.now() + COUNTDOWN_MS + GO_HOLD_MS;
  sendUpdate(control.ws, {
    raceState: 'COUNTDOWN',
    raceStartTime: null,
    countdownEnd,
    teams: session.teams,
  }, {
    undoBefore: {
      raceState: 'IDLE',
      raceStartTime: null,
      countdownEnd: null,
      teams: JSON.parse(JSON.stringify(session.teams)),
    },
  });
  session = await waitForSession(control.ws, (s) => s.raceState === 'COUNTDOWN');
  assert('Control starts countdown', session.raceState === 'COUNTDOWN' && session.countdownEnd === countdownEnd);
  assert('Undo snapshot stored on start', session.undoSnapshot != null);

  session = await waitForSession(displayWs.ws, (s) => s.raceState === 'RACING', COUNTDOWN_MS + GO_HOLD_MS + 3000);
  assert('Server transitions to RACING after countdown', session.raceState === 'RACING');
  assert('Team is racing', session.teams.find((t) => t.id === team.id)?.status === 'racing');
  assert('Demerit points reset on race start', session.teams.find((t) => t.id === team.id)?.demeritPoints === 0);

  session.teams[0].demeritPoints = 2;
  sendUpdate(control.ws, {
    raceState: session.raceState,
    raceStartTime: session.raceStartTime,
    countdownEnd: session.countdownEnd,
    demeritSecondsPerPoint: 10,
    teams: session.teams,
  });
  session = await waitForSession(control.ws, (s) => s.teams[0]?.demeritPoints === 2);
  assert('Control can add demerit points', session.teams[0]?.demeritPoints === 2);

  session.teams[0].status = 'finished';
  session.teams[0].runElapsedSec = 42.5;
  session.teams[0].totalTime = 62.5;
  session.teams[0].demeritsConfirmed = false;
  session.teams[0].finishedAt = Date.now();
  sendUpdate(control.ws, {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    demeritSecondsPerPoint: 10,
    teams: session.teams,
  });
  session = await waitForSession(control.ws, (s) => s.raceState === 'IDLE' && s.teams[0]?.status === 'finished');
  assert('Control finishes run with demerits', session.teams[0]?.totalTime === 62.5);
  assert('Finished team awaits demerit confirm', session.teams[0]?.demeritsConfirmed === false);

  session.teams[0].demeritsConfirmed = true;
  sendUpdate(control.ws, {
    raceState: 'IDLE',
    raceStartTime: null,
    countdownEnd: null,
    demeritSecondsPerPoint: 10,
    teams: session.teams,
  });
  session = await waitForSession(control.ws, (s) => s.teams[0]?.demeritsConfirmed === true);
  assert('Control can confirm demerits', session.teams[0]?.demeritsConfirmed === true);

  control.ws.send(JSON.stringify({ type: 'undo' }));
  session = await waitForSession(control.ws, (s) => s.teams[0]?.status === 'racing');
  assert('Undo restores racing team', session.teams[0]?.status === 'racing' && session.raceState === 'RACING');

  mgr.ws.send(JSON.stringify({ type: 'undo' }));
  await sleep(300);
  assert('Manager undo ignored', session.raceState === 'RACING');

  displayWs.ws.close();
  control.ws.close();
}

async function testManagerTeamEdits({ assert, port, mgr }) {
  console.log('\n— Manager team edits —\n');

  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  let session = await waitForSession(mgr.ws, (s) => s.teams.length === 0);

  const edited = makeTeam({
    id: 9002,
    name: 'Edited Crew',
    category: 'gemengd',
    members: ['f', 'f', 'm', 'm'],
    verkleed: true,
  });
  const displayWs = await openWs(port, 'display');
  sendUpdate(mgr.ws, idleSession([edited]));
  session = await waitForSession(mgr.ws, (s) => s.teams[0]?.name === 'Edited Crew');
  assert('Manager can set team name', session.teams[0]?.name === 'Edited Crew');
  assert('Manager can set verkleed flag', session.teams[0]?.verkleed === true);
  assert('Manager can set member composition', session.teams[0]?.members?.join('') === 'ffmm');

  session = await waitForSession(displayWs.ws, (s) => s.teams[0]?.verkleed === true);
  assert('Display receives manager team updates', session.teams[0]?.verkleed === true);
  displayWs.ws.close();
}

async function testSessionLoadRestore({ assert, port, mgr }) {
  console.log('\n— Session load & restore —\n');

  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  await waitForSession(mgr.ws, (s) => s.teams.length === 0);

  const homeWs = await openWs(port, 'home');
  const backupPayload = idleSession([
    makeTeam({ id: 8001, name: 'Restored Team', status: 'finished', totalTime: 55, runElapsedSec: 50, demeritsConfirmed: true }),
  ]);
  backupPayload.demeritSecondsPerPoint = 15;

  homeWs.ws.send(JSON.stringify({ type: 'load', session: backupPayload }));
  let session = await waitForSession(homeWs.ws, (s) => s.teams[0]?.name === 'Restored Team');
  assert('Home load restores teams from backup', session.teams[0]?.name === 'Restored Team');
  assert('Home load restores demerit setting', session.demeritSecondsPerPoint === 15);

  const control = await openWs(port, 'control');
  const countdownEnd = Date.now() + 60000;
  sendUpdate(control.ws, {
    raceState: 'COUNTDOWN',
    raceStartTime: null,
    countdownEnd,
    teams: [makeTeam({ id: 8002, name: 'Racing Block', status: 'pending' })],
  });
  session = await waitForSession(control.ws, (s) => s.raceState === 'COUNTDOWN');

  homeWs.ws.send(JSON.stringify({ type: 'load', session: idleSession([makeTeam({ id: 9999, name: 'Should Not Load' })]) }));
  await sleep(300);
  const check = await openWs(port, 'control');
  assert(
    'Load blocked during countdown',
    check.session.raceState === 'COUNTDOWN' && !check.session.teams.some((t) => t.name === 'Should Not Load'),
  );
  check.ws.close();

  control.ws.close();
  homeWs.ws.close();
}

async function testPersistence({ assert, port, mgr }) {
  console.log('\n— Persistence —\n');

  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  await waitForSession(mgr.ws, (s) => s.teams.length === 0);

  const homeWs = await openWs(port, 'home');
  homeWs.ws.send(JSON.stringify({ type: 'updateSettings', demeritSecondsPerPoint: 10 }));
  await waitForSession(homeWs.ws, (s) => s.demeritSecondsPerPoint === 10);
  homeWs.ws.close();

  mgr.ws.send(JSON.stringify({ type: 'reset' }));
  await waitForSession(mgr.ws, (s) => s.teams.length === 0);

  assert('Session file exists on disk', fs.existsSync(SESSION_FILE));
  const disk = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  assert('Disk session is IDLE after reset', disk.raceState === 'IDLE');
  assert('Reset preserves demerit setting', disk.demeritSecondsPerPoint === 10);
  assert('Disk session stores demerit setting', disk.demeritSecondsPerPoint === 10);

  mgr.ws.close();
}

async function runAllTests(port) {
  const runner = createRunner();
  const { assert, summary } = runner;

  console.log('\nGo-Kart Remastered — debug suite\n');

  await testHttpAndStatic({ assert, port });
  testScoringFormulas({ assert });

  const { mgr, session, team } = await testWsPermissions({ assert, port });
  await testDemeritSettings({ assert, port, mgr });
  await testRaceLifecycle({ assert, port, mgr, session, team });
  await testManagerTeamEdits({ assert, port, mgr });
  await testSessionLoadRestore({ assert, port, mgr });
  await testPersistence({ assert, port, mgr });

  return summary();
}

async function main(options = {}) {
  const port = options.port ?? PORT;
  const sessionBackup = backupSessionFile();

  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
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

  let result = { ok: false };
  try {
    result = await runAllTests(port);
  } finally {
    server.kill('SIGTERM');
    restoreSessionFile(sessionBackup);
  }

  return result;
}

if (require.main === module) {
  main().then((result) => process.exit(result.ok ? 0 : 1)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runAllTests, main, testScoringFormulas };
