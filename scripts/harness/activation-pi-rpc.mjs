import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

export function piRpc(root, modules, extra = [], sessionFile) {
  const cli = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--model', 'activation/smoke',
    ...modules.flatMap((module) => module.extensions.flatMap((file) => ['--extension', file])),
    ...extra.flatMap((file) => ['--extension', file]), ...(sessionFile ? ['--session', sessionFile] : []),
  ], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'), TRANSPORTX_SESSION_MODULES_JSON: JSON.stringify(modules) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', sequence = 0;
  const lines = [];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk; const parts = buffer.split(/\r?\n/); buffer = parts.pop();
    for (const line of parts) { try { lines.push(JSON.parse(line)); } catch {} }
  });
  async function wait(predicate, start = 0) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const item = lines.slice(start).find(predicate); if (item) return item;
      if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Pi timed out: ${stderr}; ${JSON.stringify(lines.slice(-3))}`);
  }
  async function send(type, extra = {}) {
    const id = `activation-${++sequence}`, start = lines.length;
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
    const response = await wait((line) => line.type === 'response' && line.id === id, start);
    assert.equal(response.success, true, JSON.stringify(response)); return { response, start };
  }
  return { send, lines, async prompt(message) { const { start } = await send('prompt', { message }); if (!message.startsWith('/')) await wait((line) => line.type === 'agent_settled', start); },
    async entries() { return (await send('get_entries')).response.data.entries; },
    async close() { if (child.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; } },
  };
}
