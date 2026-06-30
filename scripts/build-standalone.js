'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const TARGETS = {
  darwin: ['node18-macos-x64', 'node18-macos-arm64'],
  win32: ['node18-win-x64'],
};

function platformTag() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win-x64';
  return `${process.platform}-${process.arch}`;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function main() {
  const targets = TARGETS[process.platform];
  if (!targets) {
    console.error(`Standalone build is not configured for ${process.platform}.`);
    console.error('Run build:release for a portable folder, or build on macOS/Windows.');
    process.exit(1);
  }

  const version = pkg.version;
  const outName = `Go-Kart-Remastered-v${version}-standalone-${platformTag()}`;
  const outDir = path.join(ROOT, 'release', outName);

  console.log(`\n  Building standalone Go-Kart Remastered v${version}\n`);

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });

  const pkgBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');
  if (!fs.existsSync(pkgBin)) {
    console.log('  Installing pkg…');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'pkg@5.8.1'], { cwd: ROOT });
  }

  for (const target of targets) {
    const base = target.includes('win') ? 'go-kart-remastered.exe' : 'go-kart-remastered';
    console.log(`  Compiling ${target}…`);
    run(pkgBin, [
      path.join(ROOT, 'server.js'),
      '--target', target,
      '--output', path.join(outDir, base),
      '--compress', 'GZip',
    ], { cwd: ROOT, shell: process.platform === 'win32' });
  }

  copyRecursive(path.join(ROOT, 'public'), path.join(outDir, 'public'));
  for (const file of [
    'Start Go-Kart Remastered.command',
    'Start Go-Kart Remastered.bat',
    'README.md',
  ]) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, file));
  }
  if (process.platform === 'darwin') {
    fs.chmodSync(path.join(outDir, 'Start Go-Kart Remastered.command'), 0o755);
    const bin = path.join(outDir, 'go-kart-remastered');
    if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
  }

  console.log(`\n  Standalone release ready (no Node.js required on target PC):\n    ${outDir}\n`);
}

main();
