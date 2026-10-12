const { test } = require('node:test') as typeof import('node:test');

test('Model access and mutations preserve credentials, concurrent writes, backups and Host ownership', async (t) => {
  {
    const assert = require('node:assert/strict');
    const { createModelRpcHandlers } = require('../../bin/rpc-handlers/model.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Model RPC registry registers every model and Provider command
    {
      const handlers = createModelRpcHandlers({
        agentDir: '/tmp/transportx-models',
        getAvailableModels: async () => ['openai/gpt-5.5'],
        invalidateModelListCache() { },
        errorMessage(error: unknown) { return String(error); },
      });
      assert.deepEqual(Object.keys(handlers).sort(), [
        'add_model',
        'connect_model_provider',
        'delete_model',
        'delete_model_provider',
        'disconnect_model_provider',
        'get_available_models',
        'get_model_providers',
        'update_model',
      ]);
      assert.deepEqual(await handlers.get_available_models.handle({ type: 'get_available_models' }, reply), {
        success: true,
        data: { models: ['openai/gpt-5.5'] },
      });
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { connectPiModelProvider, disconnectPiModelProvider, listAvailablePiModels, listPiModelProviders } = require('../../bin/pi-model-access.js');
    const { updatePiModel, deletePiModelProvider } = require('../../bin/pi-model-config.js');

    // Pi provider access reuses auth.json in the configured TransportX directory
    {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-access-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      const before = await listPiModelProviders(agentDir);
      const candidate = before.find((provider: { id: string }) => provider.id === 'xiaomi-token-plan-cn');
      assert.ok(candidate);
      assert.equal(candidate.credentialStored, false);
      assert.ok(candidate.authMethods.includes('api_key'));

      const connected = await connectPiModelProvider(candidate.id, 'test-token-plan-key', agentDir);
      assert.equal(connected.connected, true);
      assert.equal(connected.credentialStored, true);
      const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
      assert.deepEqual(auth[candidate.id], { type: 'api_key', key: 'test-token-plan-key' });
      if (require('../../bin/host-platform.js').hostPlatform.posixPermissions) assert.equal(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777, 0o600);
      else t.diagnostic('Windows ACL permissions cannot be verified through POSIX mode bits');
      const models = await listAvailablePiModels(agentDir);
      const providerModels = models.filter((model: { provider: string }) => model.provider === candidate.id);
      // Login can refresh the provider catalog; availability must not depend on its previous count.
      assert.ok(providerModels.length > 0, 'connecting a provider exposes usable models');
      assert.ok(providerModels.every((model: { id?: string; contextWindow?: number; maxOutput?: number }) => model.id && model.contextWindow && model.maxOutput));

      await disconnectPiModelProvider(candidate.id, agentDir);
      const after = await listPiModelProviders(agentDir);
      assert.equal(after.find((provider: { id: string; credentialStored: boolean }) => provider.id === candidate.id)?.credentialStored, false);
      assert.equal((await listAvailablePiModels(agentDir)).some((model: { provider: string }) => model.provider === candidate.id), false);
    }

    // provider deletion cannot overwrite a model update across await
    {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-model-concurrent-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      const file = path.join(agentDir, 'models.json');
      fs.writeFileSync(file, JSON.stringify({ providers: { remove: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'a' }] }, keep: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'b', name: 'before' }] } } }));
      await Promise.all([deletePiModelProvider('remove', agentDir), updatePiModel({ provider: 'keep', modelId: 'b', name: 'after', reasoning: true }, agentDir)]);
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(config.providers.remove, undefined);
      assert.equal(config.providers.keep.models[0].name, 'after');
      assert.ok(fs.existsSync(`${file}.bak`));
    }

    // corrupt JSON refuses mutations, and atomic writes retain the previous valid copy
    {
      const { readJsonObject, writeJsonAtomic, acquireWriteLease } = require('../../bin/util/json-storage.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-json-recovery-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'models.json');
      fs.writeFileSync(file, '{broken');
      assert.throws(() => readJsonObject(file), /corrupt/);
      assert.throws(() => writeJsonAtomic(file, { providers: {} }), /corrupt/);
      await assert.rejects(updatePiModel({ provider: 'keep', modelId: 'b' }, root), /corrupt/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
      fs.writeFileSync(file, '{"providers":{}}');
      writeJsonAtomic(file, { providers: { next: {} } });
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { providers: {} });
      assert.equal(fs.readdirSync(root).some((name: string) => name.endsWith('.tmp')), false);
      const release = acquireWriteLease(file);
      assert.throws(() => acquireWriteLease(file), /writer/);
      release();
      const again = acquireWriteLease(file);
      again();
    }

    // Dead owners are recovered, while incomplete/unknown owners and competing generations stay protected.
    {
      const crypto = require('node:crypto');
      const { spawnSync } = require('node:child_process');
      const { acquireWriteLease } = require('../../bin/util/json-storage.js');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      assert.ok(deadPid > 0);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-stale-lease-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const target = path.join(root, 'host');
      const lock = `${target}.transportx-lock`;
      const writeOwner = (legacy: boolean, pid = deadPid) => {
        fs.mkdirSync(lock);
        const nonce = crypto.randomUUID();
        const file = path.join(lock, legacy ? 'owner.json' : `owner.${nonce}.json`);
        fs.writeFileSync(file, JSON.stringify({ pid, nonce, createdAt: new Date().toISOString() }));
        return file;
      };
      for (const legacy of [false, true]) {
        writeOwner(legacy);
        const release = acquireWriteLease(target);
        assert.equal(JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0]), 'utf8')).pid, process.pid);
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        release(); release();
        assert.equal(fs.existsSync(lock), false);
      }
      for (const content of [null, '{broken', '{}', JSON.stringify({ pid: -1, nonce: crypto.randomUUID() })]) {
        fs.mkdirSync(lock);
        if (content !== null) fs.writeFileSync(path.join(lock, 'owner.json'), content);
        const before = fs.readdirSync(lock);
        // Even an old malformed directory does not prove its owner is dead.
        fs.utimesSync(lock, new Date(0), new Date(0));
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        assert.deepEqual(fs.readdirSync(lock), before);
        fs.rmSync(lock, { recursive: true });
      }
      const kill = process.kill;
      for (const code of ['EPERM', 'EINVAL']) {
        const file = writeOwner(false);
        const before = fs.readFileSync(file, 'utf8');
        process.kill = ((pid: number, signal: any) => { if (pid === deadPid) throw Object.assign(new Error('unknown process status'), { code }); return kill(pid, signal); }) as typeof process.kill;
        try { assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy'); }
        finally { process.kill = kill; }
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        fs.rmSync(lock, { recursive: true });
      }
      // Pause contender A after its read, let B acquire, then resume A. A must not delete B's lock.
      for (const legacy of [false, true]) {
        writeOwner(legacy);
        let releaseWinner: (() => void) | undefined;
        let winnerFile = '';
        let winnerBytes = '';
        process.kill = ((pid: number, signal: any) => {
          if (pid === deadPid) {
            process.kill = kill;
            releaseWinner = acquireWriteLease(target);
            winnerFile = path.join(lock, fs.readdirSync(lock)[0]);
            winnerBytes = fs.readFileSync(winnerFile, 'utf8');
          }
          return kill(pid, signal);
        }) as typeof process.kill;
        try { assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy'); }
        finally { process.kill = kill; }
        assert.equal(fs.readFileSync(winnerFile, 'utf8'), winnerBytes);
        releaseWinner!();
        assert.equal(fs.existsSync(lock), false);
      }
    }

    // another process cannot take a Host lease or mutate its Agent directory
    {
      const { acquireWriteLease } = require('../../bin/util/json-storage.js');
      const { execFileSync } = require('node:child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-host-writer-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const release = acquireWriteLease(path.join(root, 'host'));
      t.after(release);
      const output = execFileSync(process.execPath, ['-e', `const {acquireWriteLease,assertHostWriter}=require('./bin/util/json-storage.js');for(const attempt of [()=>acquireWriteLease(require('path').join(process.argv[1],'host')),()=>assertHostWriter(process.argv[1])]){try{attempt();process.exitCode=1}catch(e){if(e.code!=='writer_busy')throw e;process.stdout.write(e.code+'\\n')}}`, root], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(output.trim().split('\n').length, 2);
    }

    // failed atomic replacement preserves the target, backup and removes temporary files
    {
      const { writeJsonAtomic } = require('../../bin/util/json-storage.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-json-interrupt-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'settings.json');
      fs.writeFileSync(file, '{"tau":{"authEnabled":true}}');
      const rename = fs.renameSync;
      fs.renameSync = (source: string, destination: string) => { if (destination === file) throw new Error('interrupted replacement'); return rename(source, destination); };
      try { assert.throws(() => writeJsonAtomic(file, { tau: { authEnabled: false } }), /interrupted/); }
      finally { fs.renameSync = rename; }
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tau.authEnabled, true);
      assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).tau.authEnabled, true);
      assert.equal(fs.readdirSync(root).some((name: string) => name.endsWith('.tmp')), false);
    }
  }
});
