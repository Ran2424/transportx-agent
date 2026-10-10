const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const crypto = require('node:crypto');

const {
  applyAttachmentMessageRefs,
  deleteSessionAttachment,
  listSessionAttachments,
  readAttachmentMessageRefs,
  recordAttachmentMessageRefs,
  saveUploadedAttachments,
} = require('../../bin/session-attachments.js');

function multipart(files: Array<{ name: string; type: string; body: string }>) {
  const boundary = '----transportx-test-boundary';
  const chunks: string[] = [];
  for (const file of files) chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.body}\r\n`);
  chunks.push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.from(chunks.join('')) };
}

function request(boundary: string) {
  const req = new PassThrough() as any;
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return req;
}

caseTest('a failed upload cannot remove the temporary file of another active request', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-owner-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart([{ name: 'owner.txt', type: 'text/plain', body: 'a'.repeat(1024) }]);
  const active = request(payload.boundary);
  const completion = saveUploadedAttachments(cwd, active, 'picker');
  completion.catch(() => {});
  const suffix = Buffer.from(`\r\n--${payload.boundary}--\r\n`);
  active.write(payload.body.subarray(0, payload.body.length - suffix.length));
  const tempRoot = path.join(cwd, '.tau', 'attachment-tmp');
  const deadline = Date.now() + 2000;
  while (!fs.readdirSync(tempRoot, { recursive: true }).some((name: string) => name.endsWith('.tmp'))) {
    assert.ok(Date.now() < deadline, 'active upload opened its temporary file');
    await new Promise((resolve) => setImmediate(resolve));
  }
  const failed = new PassThrough() as any;
  failed.headers = {};
  failed.end('bad');
  await assert.rejects(saveUploadedAttachments(cwd, failed, 'picker'));
  active.end(suffix);
  const [attachment] = await completion;
  assert.equal(fs.readFileSync(path.join(cwd, attachment.relativePath), 'utf8'), 'a'.repeat(1024));
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

caseTest('concurrent successful uploads preserve both index entries and clean request directories', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-concurrent-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const uploads = ['first', 'second'].map((name) => {
    const payload = multipart([{ name: `${name}.txt`, type: 'text/plain', body: name }]);
    const req = request(payload.boundary);
    const result = saveUploadedAttachments(cwd, req, 'picker');
    req.end(payload.body);
    return result;
  });
  await Promise.all(uploads);
  assert.deepEqual(listSessionAttachments(cwd).map((file: any) => file.name).sort(), ['first.txt', 'second.txt']);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
});

caseTest('fragmented boundaries, incomplete and aborted requests release only their own files', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-abort-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart([{ name: 'split.txt', type: 'text/plain', body: 'split body' }]);
  const split = request(payload.boundary);
  const success = saveUploadedAttachments(cwd, split, 'picker');
  success.catch(() => {});
  for (const byte of payload.body) { split.write(Buffer.from([byte])); await new Promise((resolve) => setImmediate(resolve)); }
  split.end();
  assert.equal((await success).length, 1);
  for (const abort of [false, true]) {
    const req = request(payload.boundary);
    const result = saveUploadedAttachments(cwd, req, 'picker');
    const rejection = assert.rejects(result);
    req.write(payload.body.subarray(0, payload.body.length - 20));
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (abort) req.destroy(new Error('client disconnected')); else req.end();
    await rejection;
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
  }
});

caseTest('uploads reject more than twenty files without retaining any temporary files', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-count-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart(Array.from({ length: 21 }, (_, index) => ({ name: `${index}.txt`, type: 'text/plain', body: 'x' })));
  const req = request(payload.boundary);
  const result = saveUploadedAttachments(cwd, req, 'picker');
  req.end(payload.body);
  await assert.rejects(result, (error: any) => error.status === 413);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
});

caseTest('total multipart bytes include non-file fields and stop at 100 MB', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-total-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const boundary = 'total-limit-boundary';
  const chunk = Buffer.alloc(1024 * 1024, 'x');
  const req = require('node:stream').Readable.from((async function* () {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n`);
    for (let index = 0; index < 101; index++) yield chunk;
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  })());
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  await assert.rejects(saveUploadedAttachments(cwd, req, 'picker'), (error: any) => error.status === 413 && /100 MB/.test(error.message));
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
});

caseTest('uploads multiple files into session-scoped attachment directories', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-attachments-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart([
    { name: '../../交通组织方案.pdf', type: 'application/pdf', body: 'pdf bytes' },
    { name: 'table.csv', type: 'text/csv', body: 'a,b\n1,2' },
  ]);
  const req = new PassThrough() as any;
  req.headers = { 'content-type': `multipart/form-data; boundary=${payload.boundary}` };
  const promise = saveUploadedAttachments(cwd, req, 'picker');
  req.end(payload.body);
  const attachments = await promise;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].name, '交通组织方案.pdf');
  assert.equal(attachments[0].kind, 'pdf');
  assert.equal(attachments[1].kind, 'table');
  for (const attachment of attachments) {
    assert.match(attachment.relativePath, /^attachments\/att_[a-z0-9]+\/[^/]+$/);
    assert.ok(fs.statSync(path.join(cwd, attachment.relativePath)).isFile());
    assert.equal(attachment.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, attachment.relativePath))).digest('hex'));
  }
  assert.equal(listSessionAttachments(cwd).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.tau', 'attachments.json'), 'utf8')).version, 1);
});

caseTest('oversized uploads drain the request and clean temporary files', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-attachment-limit-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart([{ name: 'large.bin', type: 'application/octet-stream', body: 'x'.repeat(50 * 1024 * 1024 + 1) }]);
  const req = new PassThrough() as any;
  req.headers = { 'content-type': `multipart/form-data; boundary=${payload.boundary}` };
  const promise = saveUploadedAttachments(cwd, req, 'picker');
  req.end(payload.body);
  await assert.rejects(promise, (error: any) => error.status === 413 && /Please provide the file's path/.test(error.message));
  assert.equal(req.readableEnded, true);
  assert.equal(listSessionAttachments(cwd).length, 0);
});

caseTest('message attachment refs survive index reload and protect sent files', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-attachment-refs-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const payload = multipart([{ name: 'notes.txt', type: 'text/plain', body: 'notes' }]);
  const req = new PassThrough() as any;
  req.headers = { 'content-type': `multipart/form-data; boundary=${payload.boundary}` };
  const promise = saveUploadedAttachments(cwd, req, 'picker');
  req.end(payload.body);
  const [attachment] = await promise;
  recordAttachmentMessageRefs(cwd, { text: '检查附件', timestamp: 123, attachmentIds: [attachment.id] });
  assert.deepEqual(readAttachmentMessageRefs(cwd)[0].attachmentIds, [attachment.id]);
  const entries = applyAttachmentMessageRefs([{ type: 'message', message: { role: 'user', content: '检查附件', timestamp: 123 } }], readAttachmentMessageRefs(cwd));
  assert.deepEqual(entries[0].message.attachmentIds, [attachment.id]);
  assert.throws(() => deleteSessionAttachment(cwd, attachment.id), /already used/);
});
