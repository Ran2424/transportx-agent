const { test } = require('node:test') as typeof import('node:test');

test('Release versions and the total test budget remain consistent', async (t) => {
  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');

    // package and lockfile versions match the latest changelog version
    {
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
    }
  }

  // The budget covers all registrations, including skipped/todo and hidden subtests.
  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const { checkTestBudget } = await import(require('node:url').pathToFileURL(path.resolve('scripts/check-test-budget.mjs')).href);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-test-budget-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'test', 'suites');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'budget.test.ts');
    const prefix = "const { test } = require('node:test');\n";
    const registrations = Array.from({ length: 40 }, (_, index) => `test('scenario ${index}', { skip: ${index === 0}, todo: ${index === 1} }, () => {});`).join('\n');
    fs.writeFileSync(file, prefix + registrations);
    assert.equal(checkTestBudget(root), 40);
    fs.appendFileSync(file, "\ntest('extra', () => {});");
    assert.throws(() => checkTestBudget(root), /41\/40 total tests/);
    for (const [source, message] of [
      [prefix + "test('parent', async (t) => { await t.test('child', () => {}); });", /subtests are forbidden/],
      [prefix + "function hidden(context: import('node:test').TestContext) { context.test('child', () => {}); } test('parent', (t) => hidden(t));", /subtests are forbidden/],
      [prefix + "for (let i = 0; i < 50; i++) test('dynamic', () => {});", /loop test registrations are forbidden/],
      [prefix + "const alias = test; alias('hidden', () => {});", /cannot be assigned/],
      ["const { test: alias } = require('node:test'); alias('hidden', () => {});", /unaliased/],
    ]) {
      fs.writeFileSync(file, source);
      assert.throws(() => checkTestBudget(root), message);
    }
    const reporter = require('node:url').pathToFileURL(path.resolve('scripts/test-budget-reporter.mjs')).href;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    fs.writeFileSync(file, prefix + registrations);
    const accepted = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], { encoding: 'utf8', env });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Test runtime budget: 40\/40 total tests/);
    fs.writeFileSync(file, prefix + "test('parent', async (t) => { for (let i = 0; i < 40; i++) await t.test('child ' + i, () => {}); });");
    const rejected = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], { encoding: 'utf8', env });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stdout, /Test budget exceeded at runtime: 41\/40 total tests/);
  }
});
