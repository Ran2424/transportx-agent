const { test } = require('node:test') as typeof import('node:test');

test('Session close, history deletion and process cancellation preserve writer ownership', async (t) => {
  {
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createSessionWorkingDirectory, makeSessionId } = require('../../bin/session-workspace.js');

    // history delete holds a file gate while waiting for an existing resume and Writer
    {
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-history-delete-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'history.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      const manager = new LiveSessionManager();
      let resume!: (session: unknown) => void;
      let stop!: () => void;
      manager.pendingResumes.set(file, new Promise((resolve) => { resume = resolve; }));
      const deletion = manager.deleteHistory(file);
      deletion.catch(() => { });
      await assert.rejects(manager.resume({ sessionFile: file, cwd: root }), /delet/i);
      assert.ok(fs.existsSync(file));
      const session = { id: 'writer', sessionFile: file, terminate: () => new Promise<void>((resolve) => { stop = resolve; }) };
      manager.sessions.set(session.id, session);
      resume(session);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(fs.existsSync(file));
      stop();
      await deletion;
      assert.equal(fs.existsSync(file), false);
    }

    // creates unique, safe task directories under an explicit project root
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-workspace-'));
      try {
        const first = createSessionWorkingDirectory(root, '  徐家汇 / 上午:分析  ');
        const second = createSessionWorkingDirectory(root, '  徐家汇 / 上午:分析  ');
        assert.equal(path.dirname(first), root);
        assert.equal(path.dirname(second), root);
        assert.notEqual(first, second);
        assert.match(path.basename(first), /^\d{8}-\d{6}-徐家汇-+上午-分析$/);
        assert.equal(path.basename(first).includes('/'), false);
        assert.equal(path.basename(first).includes(':'), false);
        assert.match(makeSessionId(), /^tau_[a-z0-9]+_[a-z0-9]{7}$/);
        assert.throws(() => createSessionWorkingDirectory(path.join(root, 'missing')), /Directory not found/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    // uses the configured cross-platform scenario directory when no project root is supplied
    {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-default-workspace-'));
      t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
      const created = execFileSync(process.execPath, ['-e', [
        "const { createSessionWorkingDirectory } = require('./bin/session-workspace.js');",
        "process.stdout.write(createSessionWorkingDirectory(undefined, 'default-root'));",
      ].join('')], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          TAU_USER_DATA_DIR: userDataDir,
          TAU_PROJECTS_DIR: '',
          PI_CODING_AGENT_DIR: path.join(userDataDir, 'pi'),
        },
      });
      assert.equal(path.dirname(created), path.join(userDataDir, 'scenario'));
    }

    // real Writer exit precedes history removal, and stop failures preserve history
    {
      const { spawn } = require('node:child_process');
      const { terminateProcessTree } = require('../../bin/process-tree.js');
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-writer-exit-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'history.jsonl');
      const child = spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync(process.argv[1],'ready\\n');process.on('SIGTERM',()=>setTimeout(()=>{fs.appendFileSync(process.argv[1],'final\\n');process.exit(0)},100));setInterval(()=>{},1000);process.stdout.write('ready');`, file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { try { child.kill('SIGKILL'); } catch { } });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      const manager = new LiveSessionManager();
      manager.sessions.set('writer', { id: 'writer', sessionFile: file, terminate: () => terminateProcessTree(child) });
      await manager.deleteHistory(file);
      assert.notEqual(child.exitCode, null);
      assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(file, 'keep');
      manager.sessions.set('failed', { id: 'failed', sessionFile: file, terminate: async () => { throw new Error('stop failed'); } });
      await assert.rejects(manager.deleteHistory(file), /stop failed/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    }

    // session jobs enforce owner and Host limits and close waits for cancellation
    {
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const manager = new LiveSessionManager();
      for (const id of ['a', 'b', 'c']) manager.sessions.set(id, { id, terminate: async () => { } });
      const releases: Array<() => void> = [];
      let aborted = false;
      const job = (signal: AbortSignal) => new Promise<void>((resolve) => { releases.push(resolve); signal.addEventListener('abort', () => { aborted = true; resolve(); }); });
      const running = [manager.runJob('a', job), manager.runJob('a', job), manager.runJob('b', job), manager.runJob('b', job)];
      await assert.rejects(manager.runJob('a', job), /capacity/);
      await assert.rejects(manager.runJob('c', job), /capacity/);
      await new Promise((resolve) => setImmediate(resolve));
      await manager.delete('a');
      assert.equal(aborted, true);
      assert.equal(manager.get('a'), undefined);
      await assert.rejects(manager.runJob('a', job), /unavailable/);
      await manager.cancelJobs('b');
      await Promise.all(running);
      await manager.runJob('c', async () => { });
    }

    // real controlled processes enforce global capacity and release it after confirmed abort
    {
      const { ProcessRunner } = require('../../bin/process-runner.js');
      const runner = new ProcessRunner();
      const other = new ProcessRunner();
      t.after(() => Promise.all([runner.terminateAll(), other.terminateAll()]));
      const controller = new AbortController();
      const executable = { command: process.execPath, args: [], version: 'test' };
      const options = { timeoutMs: 10000, maxBuffer: 1024, signal: controller.signal };
      const runs = Array.from({ length: 4 }, () => runner.run(executable, ['-e', 'setInterval(()=>{},1000)'], options));
      const outcomes = runs.map((run) => assert.rejects(run, /cancelled/));
      await assert.rejects(other.run(executable, ['-e', ''], options), /capacity/);
      assert.equal(runner.activeCount, 4);
      controller.abort();
      await Promise.all(outcomes);
      assert.equal(runner.activeCount, 0);
      const result = await other.run(executable, ['-e', "process.stdout.write('done')"], { timeoutMs: 10000, maxBuffer: 1024 });
      assert.equal(result.stdout, 'done');
    }

    // abort stops a descendant Writer even when its parent exits first
    {
      const { ProcessRunner } = require('../../bin/process-runner.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-descendant-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const marker = path.join(root, 'writes');
      const ready = path.join(root, 'pid');
      const script = path.join(root, 'parent.cjs');
      fs.writeFileSync(script, `const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',"const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)",process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[3],String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
      const runner = new ProcessRunner();
      const controller = new AbortController();
      const run = runner.run({ command: process.execPath, args: [], version: 'test' }, [script, marker, ready], { timeoutMs: 10000, maxBuffer: 1024, signal: controller.signal });
      const rejected = assert.rejects(run, /cancelled/);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker)) { assert.ok(Date.now() < deadline, 'descendant did not start'); await new Promise((resolve) => setTimeout(resolve, 20)); }
      const pid = Number(fs.readFileSync(ready, 'utf8'));
      t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { } });
      controller.abort();
      await rejected;
      const bytes = fs.statSync(marker).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(fs.statSync(marker).size, bytes);
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createSessionRpcHandlers } = require('../../bin/rpc-handlers/session.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Session RPC handler appends a name and updates the live session
    {
      const session = { sessionFile: '/tmp/session.jsonl' };
      const updates: Array<{ session: unknown; name: string }> = [];
      const handler = createSessionRpcHandlers({
        getLiveSession: () => session,
        findLiveSessionByFile: () => null,
        appendSessionName: (filePath: string, name: string) => { assert.equal(filePath, '/tmp/session.jsonl'); assert.equal(name, '早高峰'); return filePath; },
        updateLiveSessionName: (target: unknown, name: string) => updates.push({ session: target, name }),
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', sessionId: 'session-1', name: '早高峰' }, reply), { success: true, data: { name: '早高峰' } });
      assert.deepEqual(updates, [{ session, name: '早高峰' }]);
    }

    // Session RPC handler rejects an empty name before resolving a session
    {
      const handler = createSessionRpcHandlers({
        getLiveSession() { throw new Error('should not resolve'); },
        findLiveSessionByFile() { throw new Error('should not resolve'); },
        appendSessionName() { throw new Error('should not append'); },
        updateLiveSessionName() { throw new Error('should not update'); },
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', name: ' ' }, reply), { success: false, error: 'Name cannot be empty' });
    }

    // Session RPC handler rejects names longer than the create-session limit
    {
      const handler = createSessionRpcHandlers({
        getLiveSession() { throw new Error('should not resolve'); },
        findLiveSessionByFile() { throw new Error('should not resolve'); },
        appendSessionName() { throw new Error('should not append'); },
        updateLiveSessionName() { throw new Error('should not update'); },
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', name: 'x'.repeat(121) }, reply), { success: false, error: 'Name cannot exceed 120 characters' });
    }
  }
});
