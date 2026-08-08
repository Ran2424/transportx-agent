const { test } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AGENT_HOST_READY_TYPE, parseReadyLine, validatePackagedRuntime } = require('../dist-desktop/agent-host-supervisor.js');
const { resolveDesktopUserDataDir } = require('../dist-desktop/app-paths.js');

test('macOS desktop data lives under the TransportX dot-directory', () => {
  assert.equal(resolveDesktopUserDataDir('/Users/example', '/Users/example/Library/Application Support/TransportX Traffic Agent', 'darwin', {}), '/Users/example/.transportx/traffic-agent');
});

test('Agent Host ready protocol accepts only loopback and matching protocol', () => {
  const ready = parseReadyLine(JSON.stringify({ type: AGENT_HOST_READY_TYPE, host: '127.0.0.1', port: 43123, protocolVersion: 1, pid: 123 }));
  assert.equal(ready.port, 43123);
  assert.equal(parseReadyLine('not json'), null);
  assert.equal(parseReadyLine(JSON.stringify({ ...ready, host: '0.0.0.0' })), null);
  assert.equal(parseReadyLine(JSON.stringify({ ...ready, protocolVersion: 2 })), null);
});

test('desktop supervisor validates every packaged runtime checksum', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-supervisor-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (relative: string) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative);
    return { version: '1.0.0', path: relative, sha256: crypto.createHash('sha256').update(relative).digest('hex') };
  };
  const manifest = {
    manifestVersion: 1,
    product: { name: 'TransportX Traffic Agent', version: '3.0.0' },
    agentHost: { ...make('app/host.js'), protocolVersion: 1 },
    pi: make('runtime/pi.js'),
    python: make('runtime/python'),
  };
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest));
  assert.equal(validatePackagedRuntime(root).product.version, '3.0.0');
  fs.writeFileSync(path.join(root, 'runtime/pi.js'), 'changed');
  assert.throws(() => validatePackagedRuntime(root), /checksum mismatch/);
});
