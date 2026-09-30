const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

caseTest('package and lockfile versions match the latest changelog version', () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const serverConfig = fs.readFileSync(path.join(root, 'src', 'server', 'config.ts'), 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
  const latest = changelog.match(/^## v?(\d+\.\d+\.\d+)\b/m);
  const platform = serverConfig.match(/export const PLATFORM_VERSION = ['"](\d+\.\d+\.\d+)['"];/);

  assert.ok(latest, 'docs/CHANGELOG.md must contain a SemVer heading such as ## v1.22.3');
  assert.ok(platform, 'src/server/config.ts must define PLATFORM_VERSION as a SemVer string');
  const expected = latest[1];

  assert.equal(pkg.version, expected, 'package.json version must match the latest changelog version');
  assert.equal(lock.version, expected, 'package-lock.json version must match package.json');
  assert.equal(lock.packages[''].version, expected, 'lockfile root package version must match package.json');
  assert.equal(platform[1], expected, 'src/server/config.ts PLATFORM_VERSION must match package.json');
});
