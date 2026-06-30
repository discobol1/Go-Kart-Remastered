'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8765;
const SETUP_URL = `http://localhost:${PORT}/`;
const MIN_NODE_MAJOR = 18;

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function nodeMajor() {
  const match = /^v(\d+)/.exec(process.version);
  return match ? Number(match[1]) : 0;
}

function ensureNode() {
  if (nodeMajor() < MIN_NODE_MAJOR) {
    fail(
      `Node.js ${MIN_NODE_MAJOR}+ is required (found ${process.version}).\n`
      + 'Install from https://nodejs.org/ then run this launcher again.',
    );
  }
}

function standaloneBinary() {
  const names = process.platform === 'win32'
    ? ['go-kart-remastered.exe', 'Go-Kart-Remastered.exe']
    : ['go-kart-remastered', 'Go-Kart-Remastered'];
  for (const name of names) {
    const bin = path.join(ROOT, name);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function ensureDependencies() {
  if (standaloneBinary()) return;
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(path.join(nm, 'express'))) return;

  log('Installing dependencies (first run only)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--omit=dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    fail('npm install failed. Check your internet connection and try again.');
  }
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

function waitForServer(url, attempts = 40) {
  return new Promise((resolve) => {
    const tryOnce = (left) => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(true);
        else if (left > 0) setTimeout(() => tryOnce(left - 1), 250);
        else resolve(false);
      });
      req.on('error', () => {
        if (left > 0) setTimeout(() => tryOnce(left - 1), 250);
        else resolve(false);
      });
      req.setTimeout(500, () => req.destroy());
    };
    tryOnce(attempts);
  });
}

function startServer() {
  const bin = standaloneBinary();
  const env = { ...process.env, GO_KART_ROOT: ROOT, PORT: String(PORT) };

  if (bin) {
    log(`Starting Go-Kart Remastered (standalone) on port ${PORT}…`);
    return spawn(bin, [], { cwd: ROOT, stdio: 'inherit', env });
  }

  log(`Starting Go-Kart Remastered on port ${PORT}…`);
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
}

async function main() {
  console.log('\n  Go-Kart Remastered — race server\n');
  ensureNode();
  ensureDependencies();

  const server = startServer();

  const ready = await waitForServer(SETUP_URL);
  if (ready) {
    log(`Opening setup page: ${SETUP_URL}`);
    openBrowser(SETUP_URL);
    log('\nKeep this window open while racing. Press Ctrl+C to stop the server.\n');
  } else {
    log('Server is starting — open this URL in your browser if it does not open automatically:');
    log(`  ${SETUP_URL}\n`);
  }

  server.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => server.kill('SIGINT'));
  process.on('SIGTERM', () => server.kill('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
