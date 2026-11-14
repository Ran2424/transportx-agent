import type { TestContext } from 'node:test';
import type { HttpHostFixture } from './http-host-fixture.ts';

async function assertHttpResponseFailures(fixture: HttpHostFixture, t: TestContext) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const http = require('node:http');
  const path = require('node:path');
  const { PassThrough } = require('node:stream');
  const { PROJECTS_DIR, createApiRouter, jsonBody, liveManager, request } = fixture;

  // PDF render and download cache enforce concurrency, byte and entry capacity
  {
    liveManager.sessions.clear();
    let size = 1;
    let blocked = true;
    const renders: Array<() => void> = [];
    const router = createApiRouter({
      readBody: async () => ({ title: 'report', html: '<p>report</p>' }),
      renderReportPdf: async () => { if (blocked) await new Promise<void>((resolve) => renders.push(resolve)); return Buffer.alloc(size); },
      json: (res: any, status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
      errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
      errorStatus: (error: any) => error.status || 400,
    } as any);
    const reportServer = require('node:http').createServer((req: any, res: any) => router.dispatch(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise<void>((resolve) => reportServer.listen(0, '127.0.0.1', resolve));
    t.after(() => reportServer.close());
    const origin = `http://127.0.0.1:${reportServer.address().port}`;
    const post = () => request(`${origin}/api/reports/pdf/download`, { method: 'POST' });
    const pending = [post(), post()];
    while (renders.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await post()).status, 503);
    blocked = false;
    renders.forEach((release) => release());
    await Promise.all(pending);
    const urls: string[] = [];
    for (let index = 0; index < 9; index++) urls.push((await jsonBody(await post())).url);
    assert.equal((await request(`${origin}${urls[0]}`)).status, 404);
    const consumed = await request(`${origin}${urls[8]}`);
    assert.equal(consumed.status, 200);
    await consumed.arrayBuffer();
    assert.equal((await request(`${origin}${urls[8]}`)).status, 404);
    size = 32 * 1024 * 1024;
    const first = (await jsonBody(await post())).url;
    await post();
    size = 1;
    await post();
    assert.equal((await request(`${origin}${first}`)).status, 404);
    size = 32 * 1024 * 1024 + 1;
    assert.equal((await post()).status, 413);
  }

  // Router failures settle leases and never write a second response.
  {
    const { ServerRouter } = require('../../bin/router.js');
    let active = 0;
    const router = new ServerRouter({}, () => { active++; return () => { active--; }; });
    router.get('/sync', () => { throw new Error('password=fixture-secret'); });
    router.get('/async', async () => { throw new Error('password=fixture-secret'); });
    router.get('/partial', async ({ res }: any) => { res.write('partial'); throw new Error('stream failure'); });
    const { streamResponse } = require('../../bin/http/response.js');
    const { createFileApiHandlers } = require('../../bin/file-api-handler.js');
    const raw = path.join(PROJECTS_DIR, 'range-failure.txt');
    fs.writeFileSync(raw, '0123456789');
    const routeFiles = createFileApiHandlers({ expandHome: (value: string) => value, json: require('../../bin/http/response.js').writeJson, errorMessage: (error: Error) => error.message });
    let abortedStream: any;
    router.get('/disconnected', ({ res }: any) => { abortedStream = new PassThrough(); streamResponse(abortedStream, res); abortedStream.write('partial'); });
    router.get('/range', ({ req, res }: any) => routeFiles.serveRawFile(req, res, raw, false));
    const failureServer = http.createServer((req: any, res: any) => router.dispatch(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise<void>((resolve) => failureServer.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${failureServer.address().port}`;
      for (const route of ['/sync', '/async']) {
        const response = await request(origin + route);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { code: 'http_operation_failed', error: 'The Host could not complete this request.' });
        assert.equal(active, 0);
      }
      await assert.rejects(async () => (await request(origin + '/partial')).text());
      const disconnect = new AbortController();
      const response = await request(origin + '/disconnected', { signal: disconnect.signal });
      assert.equal(response.status, 200);
      const closed = new Promise<void>((resolve) => abortedStream.once('close', resolve));
      disconnect.abort();
      await closed;
      assert.equal(abortedStream.destroyed, true);
      const stream = new PassThrough();
      const stub = t.mock.method(fs, 'createReadStream', () => stream);
      try {
        const range = request(origin + '/range', { headers: { Range: 'bytes=0-3' } });
        while (stub.mock.callCount() === 0) await new Promise((resolve) => setImmediate(resolve));
        stream.write('0');
        const ranged = await range;
        assert.equal(ranged.status, 206);
        stream.destroy(Object.assign(new Error('disk read failed'), { code: 'EIO' }));
        await assert.rejects(ranged.text());
      } finally { stub.mock.restore(); }
      assert.equal(active, 0);
    } finally { await new Promise<void>((resolve) => failureServer.close(resolve)); }
  }
}

module.exports = { assertHttpResponseFailures };
