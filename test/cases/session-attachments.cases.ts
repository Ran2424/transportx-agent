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
