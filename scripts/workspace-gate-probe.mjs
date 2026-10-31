// T4 prototype only. No production lifecycle or user data is modified.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { acquireWriteLease, readJsonObject, writeJsonAtomic } = require('../bin/util/json-storage.js');
const { terminateProcessTree } = require('../bin/process-tree.js');
const { hostPlatform } = require('../bin/host-platform.js');
const cli = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');

async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}
if (process.argv[2] === 'host-actor') {
  const [workspace, agentDir, jobPid] = process.argv.slice(3);
  const releaseHost = acquireWriteLease(path.join(agentDir, 'host'));
  const target = path.join(fs.realpathSync(workspace), '.tau/probe-runtime');
  let releaseWorkspace, pi;
  try {
    releaseWorkspace = acquireWriteLease(target);
    const previous = readJsonObject(target + '.json');
    // A dead metadata Writer is insufficient evidence that Pi/jobs stopped.
    if (previous.generation && previous.stage !== 'stopped') throw Object.assign(new Error('Previous Pi/job stop is unconfirmed'), { code: 'process_stop_unconfirmed' });
    const generation = crypto.randomUUID();
    writeJsonAtomic(target + '.json', { generation, hostPid: process.pid, stage: 'starting', piPid: null, jobPid: Number(jobPid) });
    fs.mkdirSync(path.join(agentDir, 'sessions'), { recursive: true });
    pi = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--session', path.join(agentDir, 'sessions/empty.jsonl')], { cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, detached: hostPlatform.detached, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; pi.stdout.on('data', (chunk) => { output += chunk; }); pi.stderr.resume();
    pi.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
    await until(() => output.split('\n').some((line) => { try { return JSON.parse(line).id === 'ready'; } catch { return false; } }), 'real Pi ready');
    writeJsonAtomic(target + '.json', { generation, hostPid: process.pid, stage: 'running', piPid: pi.pid, jobPid: Number(jobPid) });
    process.send({ state: 'running', generation, piPid: pi.pid });
    await new Promise((resolve) => process.once('message', resolve));
    await terminateProcessTree(pi);
    writeJsonAtomic(target + '.json', { generation, stage: 'stopped' });
  } catch (error) {
    process.send({ state: 'blocked', code: error.code || error.message });
  } finally {
    if (pi && pi.exitCode === null && pi.signalCode === null) await terminateProcessTree(pi);
    releaseWorkspace?.(); releaseHost(); process.disconnect();
  }
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-gate-probe-'));
  const workspace = path.join(root, 'workspace'), alias = path.join(root, 'alias');
  fs.mkdirSync(workspace); fs.symlinkSync(workspace, alias, 'dir');
  const recordFile = path.join(workspace, '.tau/probe-runtime.json');
  const actors = [], jobs = [];
  const start = async (directory, name, jobPid = 0) => {
    const actor = fork(fileURLToPath(import.meta.url), ['host-actor', directory, path.join(root, name), String(jobPid)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let error = ''; actor.stderr.on('data', (chunk) => { error += chunk; }); actors.push(actor);
    const result = await new Promise((resolve, reject) => { actor.once('message', resolve); actor.once('error', reject); actor.once('exit', () => reject(new Error(`Host actor exited without a result: ${error}`))); });
    return { actor, result };
  };
  const close = async (actor) => {
    if (actor.exitCode !== null || actor.signalCode !== null) return;
    const exited = new Promise((resolve) => actor.once('exit', resolve)); actor.send('stop'); await exited;
  };
  const report = { at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, prototype: true, checks: [] };
  try {
    const a = await start(workspace, 'host-a'); assert.equal(a.result.state, 'running');
    const b = await start(alias, 'host-b'); assert.equal(b.result.code, 'writer_busy');
    report.checks.push('Different agentDir Host actors and path aliases share one realpath lease; only A starts real Pi.');
    await close(a.actor);
    const c = await start(alias, 'host-c'); assert.equal(c.result.state, 'running'); await close(c.actor);
    report.checks.push('Confirmed real Pi stop releases the gate for the next Host.');

    // This direct child represents a managed job surviving a crashed Host.
    // Its exact ChildProcess handle proves ownership; recovery never kills a guessed PID.
    const job = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: hostPlatform.detached, stdio: 'ignore' }); jobs.push(job);
    const crashed = await start(workspace, 'host-crash', job.pid);
    assert.equal(crashed.result.state, 'running');
    const exited = new Promise((resolve) => crashed.actor.once('exit', resolve)); crashed.actor.kill('SIGKILL'); await exited;
    assert.equal(job.exitCode, null);
    const denied = await start(alias, 'host-recovery'); assert.equal(denied.result.code, 'process_stop_unconfirmed');
    const record = readJsonObject(recordFile); assert.equal(record.generation, crashed.result.generation);
    report.checks.push('Dead Host lease can be reclaimed for metadata, but its unconfirmed Pi/job generation still blocks execution.');
    await terminateProcessTree(job);
    // Stop only the real Pi created by this fixture. A crash closes its RPC pipe;
    // absence is checked separately and never inferred from the Host exit.
    await until(() => { try { process.kill(record.piPid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; return true; } }, 'orphan real Pi exits');
    const recheck = (generation) => {
      const release = acquireWriteLease(path.join(workspace, '.tau/probe-runtime'));
      try {
        const current = readJsonObject(recordFile);
        if (current.generation !== generation) return 'stale_generation';
        assert.equal(job.exitCode !== null || job.signalCode !== null, true);
        writeJsonAtomic(recordFile, { generation, stage: 'stopped' }); return 'stopped';
      } finally { release(); }
    };
    assert.equal(recheck(crypto.randomUUID()), 'stale_generation');
    assert.equal(recheck(record.generation), 'stopped');
    const restored = await start(workspace, 'host-restored'); assert.equal(restored.result.state, 'running'); await close(restored.actor);
    report.checks.push('Explicit owned-job stop plus Pi exit and matching generation permits recheck; stale generation is refused.');

    const stateFile = path.join(root, 'readiness.json');
    const write = (id) => {
      const state = readJsonObject(stateFile);
      if (state.global !== 'ready') return 'system_not_ready';
      if (id !== 'new' && state.workspaces?.[id] !== 'ready') return 'workspace_migration_required';
      fs.writeFileSync(path.join(root, `written-${id}`), 'written'); return 'ok';
    };
    writeJsonAtomic(stateFile, { global: 'ready', workspaces: { healthy: 'ready', damaged: 'failed' } });
    assert.equal(write('damaged'), 'workspace_migration_required'); assert.equal(fs.existsSync(path.join(root, 'written-damaged')), false);
    assert.equal(write('healthy'), 'ok'); assert.equal(write('new'), 'ok');
    writeJsonAtomic(stateFile, { global: 'blocked', workspaces: { healthy: 'ready' } });
    assert.equal(write('healthy'), 'system_not_ready'); assert.equal(write('new'), 'system_not_ready');
    fs.writeFileSync(stateFile, '{broken'); assert.throws(() => write('new'), { code: 'metadata_corrupt' });
    report.checks.push('Filesystem prototype refuses damaged target only; healthy/new writes proceed, global/catalog corruption blocks all.');
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally {
    for (const actor of actors) { if (actor.exitCode === null && actor.signalCode === null) await close(actor); }
    for (const job of jobs) await terminateProcessTree(job);
    const output = path.resolve(process.env.TRANSPORTX_WORKSPACE_GATE_REPORT || '.plans/workspace-conversations/gate-probe.json');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, report: output, checks: report.checks }));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
