'use strict';

const fs = require('fs');
const path = require('path');

/** Application root: project folder in dev, folder containing the exe when packaged. */
function appRoot() {
  if (process.env.GO_KART_ROOT) return path.resolve(process.env.GO_KART_ROOT);
  if (process.pkg) return path.dirname(process.execPath);
  return path.join(__dirname, '..');
}

function publicDir() {
  return path.join(appRoot(), 'public');
}

function dataDir() {
  const dir = path.join(appRoot(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionFile() {
  return path.join(dataDir(), 'session.json');
}

module.exports = { appRoot, publicDir, dataDir, sessionFile };
