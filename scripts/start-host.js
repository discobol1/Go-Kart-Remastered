'use strict';

const { spawn } = require('child_process');
const http = require('http');

const PORT = Number(process.env.PORT) || 8765;
const URL = `http://localhost:${PORT}/display`;

const server = spawn('node', ['server.js'], {
  cwd: require('path').join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

function openBrowser() {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [URL], { stdio: 'ignore', detached: true }).unref();
}

function waitForServer(attempts = 30) {
  const req = http.get(URL, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode < 500) openBrowser();
    else if (attempts > 0) setTimeout(() => waitForServer(attempts - 1), 200);
  });
  req.on('error', () => {
    if (attempts > 0) setTimeout(() => waitForServer(attempts - 1), 200);
  });
  req.setTimeout(500, () => req.destroy());
}

waitForServer();

server.on('exit', (code) => process.exit(code ?? 0));

process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
