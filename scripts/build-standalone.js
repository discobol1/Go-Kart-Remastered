'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

/** pkg targets per platform (can cross-compile from macOS). */
const TARGETS = {
  darwin: ['node18-macos-x64', 'node18-macos-arm64'],
  win32: ['node18-win-x64'],
};

function parsePlatformArg() {
  const flag = process.argv.find((a) => a.startsWith('--platform='));
  if (!flag) return process.platform;
  const value = flag.split('=')[1];
  if (value !== 'darwin' && value !== 'win32') {
    console.error('Use --platform=darwin or --platform=win32');
    process.exit(1);
  }
  return value;
}

function platformTag(platform) {
  if (platform === 'darwin') {
    return process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  if (platform === 'win32') return 'win-x64';
  return `${platform}-unknown`;
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

function ensurePkg() {
  const pkgBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');
  if (!fs.existsSync(pkgBin)) {
    console.log('  Installing pkg…');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'pkg@5.8.1'], { cwd: ROOT });
  }
  return pkgBin;
}

function main() {
  const buildPlatform = parsePlatformArg();
  const targets = TARGETS[buildPlatform];
  if (!targets) {
    console.error(`Standalone build is not configured for ${buildPlatform}.`);
    process.exit(1);
  }

  const version = pkg.version;
  const tag = platformTag(buildPlatform);
  const outName = `Go-Kart-Remastered-v${version}-standalone-${tag}`;
  const outDir = path.join(ROOT, 'release', outName);

  console.log(`\n  Building standalone Go-Kart Remastered v${version} (${tag})\n`);

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });

  const pkgBin = ensurePkg();
  const isWin = buildPlatform === 'win32';
  const exeName = isWin ? 'go-kart-remastered.exe' : 'go-kart-remastered';

  for (const target of targets) {
    console.log(`  Compiling ${target}…`);
    run(pkgBin, [
      path.join(ROOT, 'server.js'),
      '--target', target,
      '--output', path.join(outDir, exeName),
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

  if (buildPlatform === 'darwin') {
    fs.chmodSync(path.join(outDir, 'Start Go-Kart Remastered.command'), 0o755);
    const bin = path.join(outDir, 'go-kart-remastered');
    if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755);
  }

  console.log(`\n  Standalone release ready (no Node.js required on target PC):\n    ${outDir}\n`);
}

main();
