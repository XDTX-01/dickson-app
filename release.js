#!/usr/bin/env node
/**
 * One-click release script:
 * bumps the patch version, then builds & publishes to GitHub Releases.
 * Launched by "release.bat" — no manual commands needed.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dir = __dirname;
const pkgPath = path.join(dir, 'package.json');
const tokenPath = path.join(dir, 'token.txt');

// 1. Read GitHub token
let token;
try {
  token = fs.readFileSync(tokenPath, 'utf8').trim();
} catch (e) {
  console.error('[ERROR] token.txt not found. Create a GitHub token and save it to token.txt first.');
  process.exit(1);
}
if (!token) {
  console.error('[ERROR] token.txt is empty.');
  process.exit(1);
}

// 2. Bump patch version (e.g. 1.0.0 -> 1.0.1)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parts = String(pkg.version).split('.').map((n) => parseInt(n, 10) || 0);
parts[2] = (parts[2] || 0) + 1;
const newVersion = parts.join('.');
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('Version bumped to: ' + newVersion);

// 3. Build & publish to GitHub Releases
console.log('Building and publishing... (first run may be slow)');
process.env.GH_TOKEN = token;
try {
  execSync('npx electron-builder --win --x64 --publish always', {
    stdio: 'inherit',
    shell: true,
    cwd: dir,
  });
} catch (e) {
  console.error('[RELEASE FAILED] Check the error output above.');
  process.exit(1);
}
console.log('Done! New version ' + newVersion + ' published to GitHub Releases.');
