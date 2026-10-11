import type { IncomingMessage } from 'node:http';

export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let received = 0;
    let failed = false;
    const fail = (error: Error) => { failed = true; chunks = []; reject(error); };
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      received += chunk.length;
      if (received > maxBytes) return fail(Object.assign(new Error('Request body too large'), { status: 413 }));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
      chunks = [];
    });
    req.on('aborted', () => fail(new Error('Request aborted')));
    req.on('error', fail);
  });
}
