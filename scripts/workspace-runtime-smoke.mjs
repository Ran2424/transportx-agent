// Real Pi and production runtime gate, with independent Host processes and no user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WorkspaceRuntimeGate } = require('../bin/workspace-runtime.js');
const { inspectRecordedProcess, stopRecordedProcess } = require('../bin/process-inspection.js');
const { terminateProcessTree } = require('../bin/process-tree.js');
const { hostPlatform } = require('../bin/host-platform.js');
const python = process.env.TAU_PYTHON_COMMAND;
assert.ok(python, 'Set TAU_PYTHON_COMMAND to the project Python 3.10 runtime.');
const workspaceId = 'ws_00000000-0000-4000-8000-000000000001', conversationId = 'conv_00000000-0000-4000-8000-000000000002';
async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${label}`);
}
if (process.argv[2] === 'host') {
  const [directory, agentDir] = process.argv.slice(3), gate = new WorkspaceRuntimeGate(python, path.join(agentDir, 'logs'), path.join(path.dirname(agentDir), 'coordination'));
  const processes = [];
  let lease;
  try {
    lease = gate.take(directory, workspaceId, conversationId);
    fs.mkdirSync(path.join(agentDir, 'sessions'), { recursive: true });
    const piTracking = lease.processIntent('pi');
    const pi = spawn(process.execPath, [path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--session', path.join(agentDir, 'sessions/empty.jsonl')], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, detached: hostPlatform.detached, stdio: ['pipe', 'pipe', 'pipe'] });
    processes.push({ child: pi, tracking: piTracking }); piTracking.started(pi);
    let output = ''; pi.stdout.on('data', (chunk) => { output += chunk; }); pi.stderr.resume();
    pi.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
    await until(() => output.split('\n').some((line) => { try { return JSON.parse(line).id === 'ready'; } catch { return false; } }), 'real Pi ready');
    const jobTracking = lease.processIntent('managed');
    const job = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: hostPlatform.detached, stdio: 'ignore' });
    processes.push({ child: job, tracking: jobTracking }); jobTracking.started(job); lease.running();
    process.send({ state: 'running', generation: lease.generation, piPid: pi.pid, jobPid: job.pid });
    await new Promise((resolve) => process.once('message', resolve));
    lease.stopping();
    for (const item of processes) { await terminateProcessTree(item.child); item.tracking.stopped(); }
    lease.finish(); lease = null;
  } catch (error) { process.send({ state: 'blocked', code: error.code, message: error.message }); }
  finally {
    for (const item of processes) { await terminateProcessTree(item.child); if (lease) item.tracking.stopped(); }
    if (lease) lease.finish(); process.disconnect();
  }
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-runtime-smoke-')), root = fs.realpathSync(temporary);
  const directory = path.join(root, 'workspace'), alias = path.join(root, 'workspace-alias');
  fs.mkdirSync(directory); fs.symlinkSync(directory, alias, 'junction');
  const gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'), path.join(root, 'coordination')), actors = [];
  const report = { at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, checks: [] };
  const start = async (target, name) => {
    const child = fork(fileURLToPath(import.meta.url), ['host', target, path.join(root, name)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; }); actors.push(child);
    const message = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error(errors || 'Host exited before reporting'))); });
    return { child, message };
  };
  const close = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.send('stop'); await exited;
  };
  try {
    const first = await start(directory, 'agent-a'); assert.equal(first.message.state, 'running', JSON.stringify(first.message));
    const second = await start(alias, 'agent-b'); assert.equal(second.message.code, 'workspace_busy');
    report.checks.push('Two Hosts using different agent directories and aliases permit only one real Pi.');
    await close(first.child);
    assert.equal(gate.diagnostics(alias).phase, 'stopped');
    const next = await start(alias, 'agent-c'); assert.equal(next.message.state, 'running', JSON.stringify(next.message));
    report.checks.push('Confirmed Pi/managed-job stop permits a new runtime generation.');
    const exited = new Promise((resolve) => next.child.once('exit', resolve)); next.child.kill('SIGKILL'); await exited;
    const crashed = gate.diagnostics(directory);
    assert.equal(crashed.hostObservation.state, 'exited');
    const job = crashed.processes.find((item) => item.kind === 'managed'); assert.equal(job.observation.state, 'running');
    assert.throws(() => gate.take(alias, workspaceId, conversationId), { code: 'process_stop_unconfirmed' });
    await assert.rejects(gate.recover(directory, crashed.generation, 'recheck'), { code: 'process_stop_unconfirmed' });
    await assert.rejects(gate.recover(alias, '00000000-0000-4000-8000-000000000000', 'stop-owned'), { code: 'workspace_revision_conflict' });
    assert.equal(inspectRecordedProcess(job.identity, python).state, 'running');
    const recovered = await gate.recover(alias, crashed.generation, 'stop-owned');
    assert.equal(recovered.phase, 'stopped'); assert.ok(recovered.processes.every((item) => item.state === 'stopped'));
    report.checks.push('Host SIGKILL leaves a live job; recheck refuses takeover, stale generation cannot stop it, explicit owned-process stop recovers.');
    const restored = gate.take(directory, workspaceId, conversationId);
    assert.notEqual(restored.generation, crashed.generation); restored.finish();
    report.checks.push('Recovery preserves the old generation until all recorded processes have stopped; fresh activation succeeds afterwards.');
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally {
    for (const child of actors) await close(child);
    try { for (const item of gate.diagnostics(directory).processes) if (item.identity) await stopRecordedProcess(item.identity, python); } catch {}
    const output = path.resolve(process.env.TRANSPORTX_WORKSPACE_RUNTIME_REPORT || '.plans/workspace-conversations/runtime-smoke.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, report: output })); fs.rmSync(root, { recursive: true, force: true });
  }
}
