const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package and lockfile versions match the latest changelog version', () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
  const latest = changelog.match(/^## v(\d+)\.(\d+)\b/m);

  assert.ok(latest, 'docs/CHANGELOG.md must contain a version heading such as ## v1.22');
  const expected = `${latest[1]}.${latest[2]}.0`;

  assert.equal(pkg.version, expected, 'package.json version must match the latest changelog version');
  assert.equal(lock.version, expected, 'package-lock.json version must match package.json');
  assert.equal(lock.packages[''].version, expected, 'lockfile root package version must match package.json');
});
