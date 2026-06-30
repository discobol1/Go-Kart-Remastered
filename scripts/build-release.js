'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const COPY_ITEMS = [
  ['public', 'public'],
  ['server.js', 'server.js'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['scripts/paths.js', 'scripts/paths.js'],
  ['scripts/launch.js', 'scripts/launch.js'],
  ['Start Go-Kart Remastered.command', 'Start Go-Kart Remastered.command'],
  ['Start Go-Kart Remastered.bat', 'Start Go-Kart Remastered.bat'],
  ['README.md', 'README.md'],
];

function platformTag() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win-x64';
  return `${process.platform}-${process.arch}`;
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function chmodMacLauncher(file) {
  if (process.platform === 'darwin' && file.endsWith('.command')) {
    fs.chmodSync(file, 0o755);
  }
}

function buildPortable() {
  const version = pkg.version;
  const outName = `Go-Kart-Remastered-v${version}-${platformTag()}`;
  const outDir = path.join(ROOT, 'release', outName);

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'data', '.gitkeep'),
    'Race session data is saved here as session.json\n',
  );

  for (const [srcRel, destRel] of COPY_ITEMS) {
    const src = path.join(ROOT, srcRel);
    if (!fs.existsSync(src)) {
      console.warn(`  skip missing: ${srcRel}`);
      continue;
    }
    const dest = path.join(outDir, destRel);
    copyRecursive(src, dest);
    chmodMacLauncher(dest);
  }

  console.log('  Installing production dependencies…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = spawnSync(npm, ['ci', '--omit=dev'], {
    cwd: outDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }

  console.log(`\n  Portable release ready:\n    ${outDir}\n`);
  console.log('  Share this folder as a zip. Users double-click the launcher (Node.js 18+ required).\n');
  return outDir;
}

function main() {
  console.log(`\n  Building Go-Kart Remastered v${pkg.version} (${platformTag()})\n`);
  buildPortable();
}

main();
