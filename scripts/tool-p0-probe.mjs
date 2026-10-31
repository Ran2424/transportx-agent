import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

// Dependency behavior probes, not acceptance of TransportX's planned trust gate.
// Uses temporary files, no model requests, and no product user data.
const piVersion = JSON.parse(fs.readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')).version;
assert.equal(piVersion, '0.80.10', 'Re-audit the dependency baseline after a Pi upgrade');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-tool-p0-'));
let child;
try {
  const cwd = path.join(root, 'workspace');
  const sessions = path.join(root, 'sessions');
  const agent = path.join(root, 'agent');
  for (const directory of [cwd, sessions, agent]) fs.mkdirSync(directory);
  const original = SessionManager.create(cwd, sessions);
  const id = original.getSessionId();
  const file = original.getSessionFile();
  const initiallyPersisted = fs.existsSync(file);
  const entryId = original.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'P0 local owner probe' }],
    api: 'openai-completions', provider: 'local', model: 'probe',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  });
  assert.ok(fs.existsSync(file));
  original.appendCustomEntry('p0-probe-note', {});
  assert.notEqual(original.getLeafId(), entryId);
  original.branch(entryId);
  assert.equal(original.getLeafId(), entryId);
  assert.equal(original.getSessionId(), id);
  assert.equal(original.getSessionFile(), file);
  assert.equal(SessionManager.open(file, sessions).getSessionId(), id);
  assert.notEqual(SessionManager.forkFrom(file, cwd, sessions).getSessionId(), id);
  const copied = path.join(sessions, 'copied-session.jsonl');
  fs.copyFileSync(file, copied);
  assert.equal(SessionManager.open(copied, sessions).getSessionId(), id);

  const extension = path.join(root, 'explicit.ts');
  const marker = path.join(root, 'loaded.txt');
  fs.writeFileSync(extension, `import fs from 'node:fs';\nexport default function () { fs.writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`);
  const started = performance.now();
  child = spawn(process.execPath, [
    path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-approve', '--extension', extension,
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let buffer = '';
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Pi get_state timed out')), 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Pi exited before state (${code})`)); });
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'response' && item.id === 'p0-state') { clearTimeout(timer); resolve(item); }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 'p0-state', type: 'get_state' })}\n`);
  });
  assert.equal(response.success, true);
  assert.ok(fs.existsSync(marker), 'Review Pi behavior if explicit extensions stop loading before project trust');
  console.log(JSON.stringify({
    pi: piVersion, newHeaderInitiallyOnDisk: initiallyPersisted,
    assistantFlushPersistsHeader: true, sameFileBranchPreservesIdentity: true,
    reopenPreservesHeaderId: true, forkHasNewHeaderId: true,
    rawCopyPreservesHeaderId: true, rawCopyHasDifferentFileKey: true,
    explicitExtensionRunsWithProjectTrustDenied: true,
    spawnToStateMs: Math.round(performance.now() - started),
    measurementScope: 'one temporary CLI startup, not a production performance budget',
  }, null, 2));
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
