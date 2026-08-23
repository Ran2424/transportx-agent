import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type {
  SessionAttachment,
  SessionAttachmentKind,
  SessionAttachmentSource,
} from '../contracts/attachments.js';
import { within } from './asset-integrity.js';
import { relativePosixPath } from './util/path.js';

const INDEX_VERSION = 1;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_ID_RE = /^att_[a-z0-9]{12,32}$/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', '7z', 'rar']);

type AttachmentIndex = {
  version: 1;
  attachments: SessionAttachment[];
  messageRefs?: AttachmentMessageRef[];
};

export type AttachmentMessageRef = {
  text: string;
  timestamp?: number;
  attachmentIds: string[];
};

type MultipartFile = {
  name: string;
  mimeType: string;
  tempPath: string;
  size: number;
  sha256: string;
};

function sessionAttachmentsDir(cwd: string) { return path.join(cwd, 'attachments'); }
function tauDir(cwd: string) { return path.join(cwd, '.tau'); }
function indexPath(cwd: string) { return path.join(tauDir(cwd), 'attachments.json'); }

function assertNotSymlink(target: string) {
  try { if (fs.lstatSync(target).isSymbolicLink()) throw error('Attachment storage symlinks are not allowed', 403); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
}

function error(message: string, status = 400) {
  const cause = new Error(message) as Error & { status?: number };
  cause.status = status;
  return cause;
}

function safeName(name: string) {
  const base = path.basename(name.replaceAll('\\', '/')).normalize('NFKC');
  const cleaned = base.replace(/[\x00-\x1F\x7F]/g, '').replace(/[\\/:*?"<>|]/g, '-').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, 240);
}

function kindFor(name: string, mimeType: string): SessionAttachmentKind {
  const extension = path.extname(name).toLowerCase().slice(1);
  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (TABLE_EXTENSIONS.has(extension) || mimeType.includes('spreadsheet') || mimeType === 'text/csv') return 'table';
  if (ARCHIVE_EXTENSIONS.has(extension) || mimeType.includes('zip') || mimeType.includes('compressed')) return 'archive';
  if (mimeType.startsWith('text/') || ['doc', 'docx', 'ppt', 'pptx', 'rtf', 'odt'].includes(extension)) return 'document';
  return 'other';
}

function readIndex(cwd: string): AttachmentIndex {
  assertNotSymlink(tauDir(cwd));
  assertNotSymlink(indexPath(cwd));
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(cwd), 'utf8')) as Partial<AttachmentIndex>;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.attachments)) {
      return { version: INDEX_VERSION, attachments: parsed.attachments, messageRefs: Array.isArray(parsed.messageRefs) ? parsed.messageRefs : [] };
    }
  } catch { /* first upload or an interrupted old write */ }
  return { version: INDEX_VERSION, attachments: [], messageRefs: [] };
}

function writeIndex(cwd: string, index: AttachmentIndex) {
  assertNotSymlink(tauDir(cwd));
  assertNotSymlink(indexPath(cwd));
  fs.mkdirSync(tauDir(cwd), { recursive: true });
  const target = indexPath(cwd), temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function ensureWithin(root: string, target: string) {
  // Stricter than within(): the attachment root itself is not a valid target.
  if (path.resolve(root) === path.resolve(target) || !within(root, target)) throw error('Attachment path escapes the session directory', 403);
}

function resolveReadyAttachment(cwd: string, attachment: SessionAttachment) {
  if (!ATTACHMENT_ID_RE.test(attachment.id) || attachment.status !== 'ready') throw error('Attachment is not available', 404);
  const logicalRoot = path.resolve(sessionAttachmentsDir(cwd));
  const candidate = path.resolve(cwd, attachment.relativePath);
  ensureWithin(logicalRoot, candidate);
  const root = fs.realpathSync(logicalRoot);
  ensureWithin(fs.realpathSync(path.resolve(cwd)), root);
  if (fs.lstatSync(candidate).isSymbolicLink()) throw error('Attachment symlinks are not allowed', 403);
  const parent = fs.realpathSync(path.dirname(candidate));
  ensureWithin(root, parent);
  const resolved = fs.realpathSync(candidate);
  ensureWithin(root, resolved);
  if (!fs.statSync(resolved).isFile()) throw error('Attachment is not a file', 404);
  return resolved;
}

export function listSessionAttachments(cwd: string) {
  const index = readIndex(cwd);
  return index.attachments.filter((attachment) => {
    if (attachment.status !== 'ready') return false;
    try { resolveReadyAttachment(cwd, attachment); return true; } catch { return false; }
  });
}

export function resolveSessionAttachments(cwd: string, ids: string[]) {
  const attachments = listSessionAttachments(cwd);
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return ids.map((id) => {
    if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) throw error('Invalid attachment id', 400);
    const attachment = byId.get(id);
    if (!attachment) throw error('Attachment does not belong to this session', 403);
    resolveReadyAttachment(cwd, attachment);
    return attachment;
  });
}

export function attachmentFilePath(cwd: string, attachment: SessionAttachment) {
  return resolveReadyAttachment(cwd, attachment);
}

function makeId() { return `att_${crypto.randomBytes(8).toString('hex')}`; }

async function writeMultipartPart(handle: fsp.FileHandle, hash: crypto.Hash, chunk: Buffer, state: { size: number }) {
  state.size += chunk.length;
  if (state.size > MAX_ATTACHMENT_BYTES) throw error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`, 413);
  hash.update(chunk);
  await handle.write(chunk);
}

async function parseMultipart(req: IncomingMessage, tempDir: string): Promise<MultipartFile[]> {
  const contentType = String(req.headers['content-type'] || '');
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw error('Expected multipart/form-data upload', 415);
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const dataBoundary = Buffer.from(`\r\n${boundary.toString()}`);
  let buffer = Buffer.alloc(0);
  let state: 'preamble' | 'headers' | 'data' | 'done' = 'preamble';
  let current: { name: string; mimeType: string; path: string; handle: fsp.FileHandle; hash: crypto.Hash; stats: { size: number } } | null = null;
  const files: MultipartFile[] = [];
  const closeCurrent = async () => {
    if (!current) return;
    await current.handle.close();
    files.push({ name: current.name, mimeType: current.mimeType, tempPath: current.path, size: current.stats.size, sha256: current.hash.digest('hex') });
    current = null;
  };
  const consume = async (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (state === 'preamble') {
        const index = buffer.indexOf(boundary);
        if (index < 0) { buffer = buffer.slice(Math.max(0, buffer.length - boundary.length)); return; }
        buffer = buffer.slice(index + boundary.length);
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) { state = 'done'; return; }
        if (!buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) throw error('Malformed multipart boundary');
        buffer = buffer.slice(2); state = 'headers';
      } else if (state === 'headers') {
        const end = buffer.indexOf(Buffer.from('\r\n\r\n'));
        if (end < 0) { if (buffer.length > 64 * 1024) throw error('Multipart headers are too large'); return; }
        const headerText = buffer.slice(0, end).toString('utf8');
        const disposition = headerText.match(/content-disposition:\s*[^\r\n]*/i)?.[0] || '';
        const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
        if (filename !== undefined) {
          const mimeType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/octet-stream';
          const tempPath = path.join(tempDir, `upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
          current = { name: safeName(filename), mimeType, path: tempPath, handle: await fsp.open(tempPath, 'w', 0o600), hash: crypto.createHash('sha256'), stats: { size: 0 } };
        }
        buffer = buffer.slice(end + 4); state = 'data';
      } else if (state === 'data') {
        const index = buffer.indexOf(dataBoundary);
        if (index < 0) {
          const safeLength = Math.max(0, buffer.length - dataBoundary.length);
          if (safeLength && current) await writeMultipartPart(current.handle, current.hash, buffer.slice(0, safeLength), current.stats);
          buffer = buffer.slice(safeLength); return;
        }
        if (index && current) await writeMultipartPart(current.handle, current.hash, buffer.slice(0, index), current.stats);
        await closeCurrent();
        buffer = buffer.slice(index + dataBoundary.length);
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) { state = 'done'; return; }
        if (!buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) throw error('Malformed multipart boundary');
        buffer = buffer.slice(2); state = 'headers';
      } else return;
    }
  };
  for await (const chunk of req) await consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if ((state as string) === 'data' || current) throw error('Incomplete multipart upload', 400);
  if ((state as string) !== 'done') throw error('Malformed multipart upload', 400);
  return files;
}

export async function saveUploadedAttachments(cwd: string, req: IncomingMessage, source: SessionAttachmentSource) {
  assertNotSymlink(tauDir(cwd));
  assertNotSymlink(sessionAttachmentsDir(cwd));
  fs.mkdirSync(sessionAttachmentsDir(cwd), { recursive: true, mode: 0o700 });
  const tempDir = path.join(tauDir(cwd), 'attachment-tmp');
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  let files: MultipartFile[];
  try {
    files = await parseMultipart(req, tempDir);
  } catch (cause) {
    for (const name of fs.readdirSync(tempDir)) { try { fs.rmSync(path.join(tempDir, name), { force: true }); } catch {} }
    throw cause;
  }
  if (!files.length) throw error('No file was provided', 400);
  const index = readIndex(cwd);
  const created: SessionAttachment[] = [];
  try {
    for (const file of files) {
      const id = makeId();
      const dir = path.join(sessionAttachmentsDir(cwd), id);
      const target = path.join(dir, file.name);
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      ensureWithin(sessionAttachmentsDir(cwd), dir);
      fs.renameSync(file.tempPath, target);
      const attachment: SessionAttachment = { id, name: file.name, relativePath: relativePosixPath(cwd, target), mimeType: file.mimeType, size: file.size, sha256: file.sha256, kind: kindFor(file.name, file.mimeType), source, status: 'ready', createdAt: new Date().toISOString() };
      index.attachments.push(attachment); created.push(attachment);
    }
    writeIndex(cwd, index);
    return created;
  } catch (cause) {
    for (const file of files) { try { fs.rmSync(file.tempPath, { force: true }); } catch {} }
    for (const attachment of created) { try { fs.rmSync(path.join(cwd, attachment.relativePath.split('/').slice(0, -1).join('/')), { recursive: true, force: true }); } catch {} }
    throw cause;
  } finally {
    for (const file of files) { try { fs.rmSync(file.tempPath, { force: true }); } catch {} }
  }
}

export function deleteSessionAttachment(cwd: string, id: string) {
  assertNotSymlink(sessionAttachmentsDir(cwd));
  const index = readIndex(cwd);
  const attachment = index.attachments.find((item) => item.id === id);
  if (!attachment) throw error('Attachment not found', 404);
  if ((index.messageRefs || []).some((ref) => ref.attachmentIds.includes(id))) throw error('Attachment is already used by a message', 409);
  const dir = path.resolve(cwd, path.dirname(attachment.relativePath));
  ensureWithin(sessionAttachmentsDir(cwd), dir);
  assertNotSymlink(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  index.attachments = index.attachments.filter((item) => item.id !== id);
  writeIndex(cwd, index);
}

export function readAttachmentMessageRefs(cwd: string) { return readIndex(cwd).messageRefs || []; }

export function recordAttachmentMessageRefs(cwd: string, ref: AttachmentMessageRef) {
  const index = readIndex(cwd);
  const refs = index.messageRefs || [];
  const key = `${ref.timestamp || ''}\n${ref.text}`;
  const existing = refs.findIndex((item) => `${item.timestamp || ''}\n${item.text}` === key);
  if (existing >= 0) refs[existing] = ref; else refs.push(ref);
  index.messageRefs = refs; writeIndex(cwd, index);
}

export function applyAttachmentMessageRefs(entries: JsonRecordLike[], refs: AttachmentMessageRef[]) {
  const byTimestamp = new Map(refs.filter((ref) => ref.timestamp !== undefined).map((ref) => [String(ref.timestamp), ref.attachmentIds]));
  return entries.map((entry) => {
    const message = entry && typeof entry.message === 'object' && !Array.isArray(entry.message) ? entry.message as JsonRecordLike : null;
    if (!message || message.role !== 'user' || message.attachmentIds) return entry;
    const timestamp = message.timestamp !== undefined ? byTimestamp.get(String(message.timestamp)) : undefined;
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n') : '';
    const fallback = refs.find((ref) => ref.text === text && ref.attachmentIds.length);
    const attachmentIds = timestamp || fallback?.attachmentIds;
    return attachmentIds?.length ? { ...entry, message: { ...message, attachmentIds } } : entry;
  });
}

type JsonRecordLike = Record<string, any>;
