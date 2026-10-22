import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

export async function spatialRecoverySmoke({ root, json, rpc, until, restartHost, endpoint }) {
  for (const session of (await json('/api/live-sessions')).sessions) await fetch(`${endpoint()}/api/live-sessions/${session.id}`, { method: 'DELETE' });
  const report = [];
  for (const phase of ['before_commit', 'after_commit', 'during_execution']) {
    let session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: `P3 ${phase}` })).session;
    await rpc({ type: 'prompt', sessionId: session.id, message: 'success' });
    await until(async () => !(await json(`/api/live-sessions/${session.id}/snapshot`)).isStreaming, 'persisted Pi owner before fault');
    const original = await json(`/api/live-sessions/${session.id}/snapshot`);
    const point = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [121.44, 31.19] } };
    fs.writeFileSync(path.join(session.cwd, 'points.geojson'), JSON.stringify({ type: 'FeatureCollection', features: phase === 'during_execution' ? Array.from({ length: 50000 }, (_, id) => ({ ...point, id })) : [point] }));
    let captured, queryRequest, disconnected = false;
    const relay = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url.endsWith('/analyze')) captured = JSON.parse(raw);
      if (req.url.endsWith('/execution')) queryRequest = JSON.parse(raw);
      try { const response = await fetch(endpoint() + req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw }); res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text()); }
      catch { disconnected = true; res.destroy(); }
    });
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const phaseFile = path.join(root, 'fault-phase'), countFile = path.join(root, 'python-dispatch-count');
    const count = () => Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0');
    const before = count();
    try {
      await rpc({ type: 'prompt', sessionId: session.id, message: `/p1_spatial_endpoint http://127.0.0.1:${relay.address().port}` });
      fs.writeFileSync(phaseFile, phase);
      await rpc({ type: 'prompt', sessionId: session.id, message: 'spatial:' + JSON.stringify({ operation: 'buffer', inputPath: 'points.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }) });
      const deadline = Date.now() + 20000;
      while (!disconnected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(disconnected, true, 'real Host force-kill must disconnect the real request');
      assert.ok(captured?.operationId);
      assert.equal(count(), before + 1, 'exactly one real Python dispatch before the crash');
      fs.rmSync(phaseFile);
      const recoveryStart = performance.now();
      await restartHost();
      session = (await json('/api/live-sessions/resume', { filePath: original.sessionFile, cwd: original.session.cwd, model: 'probe/smoke' })).session;
      assert.notEqual(session.id, original.session.id, 'the restored live ID is not the durable owner');
      const beforeQuery = (await json(`/api/live-sessions/${session.id}/snapshot`)).entries.filter((entry) => entry.message?.role === 'toolResult').length;
      await rpc({ type: 'prompt', sessionId: session.id, message: `/p1_spatial_endpoint http://127.0.0.1:${relay.address().port}` });
      await rpc({ type: 'prompt', sessionId: session.id, message: 'spatial-status:' + JSON.stringify({ action: 'query', operationId: captured.operationId }) });
      const state = await until(async () => { const value = await json(`/api/live-sessions/${session.id}/snapshot`); return !value.isStreaming && value.entries.filter((entry) => entry.message?.role === 'toolResult').length > beforeQuery && value; }, 'real restored Pi execution query');
      const result = state.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1).message;
      assert.equal(result.isError, false);
      assert.equal(count(), before + 1, 'resume/query never dispatches a replacement computation');
      const expected = phase === 'after_commit' ? 'succeeded' : 'unknown';
      if (expected === 'succeeded') {
        assert.equal(result.details.result.analysisId, captured.operationId);
        assert.equal(result.details.recovered, true);
        const manifest = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/spatial-results', captured.operationId, 'manifest.json'), 'utf8'));
        assert.equal(result.details.result.output.sha256, manifest.output.sha256);
      } else assert.equal(result.details.state, 'unknown');
      const elapsedMs = Math.round(performance.now() - recoveryStart);
      assert.ok(elapsedMs <= 10000, 'restart and confirmation must meet the predefined local 10 second budget');
      const replay = await fetch(endpoint() + '/api/internal/spatial/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...captured, sessionId: queryRequest.sessionId, token: queryRequest.token }) });
      assert.equal(replay.status, expected === 'succeeded' ? 200 : 409);
      if (expected === 'succeeded') assert.equal((await replay.json()).reused, true);
      assert.equal(count(), before + 1, 'a repeated protected execution after restart never recomputes');
      if (phase === 'after_commit') {
        const copiedFile = path.join(root, 'sessions', 'raw-copy.jsonl');
        fs.copyFileSync(original.sessionFile, copiedFile);
        const copy = (await json('/api/live-sessions/resume', { filePath: copiedFile, cwd: original.session.cwd, model: 'probe/smoke' })).session;
        try {
          await rpc({ type: 'prompt', sessionId: copy.id, message: 'spatial-status:' + JSON.stringify({ action: 'query', operationId: captured.operationId }) });
          const value = await until(async () => { const state = await json(`/api/live-sessions/${copy.id}/snapshot`); return !state.isStreaming && state.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1)?.message.toolName === 'tau_spatial_execution' && state; }, 'raw history copy must not inherit the original execution owner');
          const last = value.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1).message;
          assert.equal(last.isError, true);
          assert.match(JSON.stringify(last.content), /unavailable to this owner/);
        } finally { await fetch(`${endpoint()}/api/live-sessions/${copy.id}`, { method: 'DELETE' }); }
      }
      report.push({ fault: phase, confirmed: expected, recoveryMs: elapsedMs, pythonDispatches: count() - before, originalResultRetained: expected === 'succeeded', protectedReplayVerified: true, ...(phase === 'after_commit' ? { rawCopyOwnerDenied: true } : {}) });
    } finally {
      fs.rmSync(phaseFile, { force: true });
      relay.closeAllConnections(); await new Promise((resolve) => relay.close(resolve));
      await fetch(`${endpoint()}/api/live-sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
      if (phase === 'during_execution' && fs.existsSync(path.join(root, 'domain-child-pid'))) {
        // Only this fixture's exact child PID is stopped; never infer a new
        // owner from a stale production job ID or claim that this is recovery.
        try { process.kill(Number(fs.readFileSync(path.join(root, 'domain-child-pid'), 'utf8')), 'SIGTERM'); } catch {}
      }
    }
  }
  return report;
}
