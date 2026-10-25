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
import { acquireWriteLease, readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { CONVERSATION_ID } from '../contracts/workspace.js';
import { conversationStatePath, workspaceMetadataPath } from './workspace-store.js';
import { isWithin } from './util/path.js';
import { relativePosixPath } from './util/path.js';

const INDEX_VERSION = 1;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_FILES = 20;
const ATTACHMENT_ID_RE = /^att_[a-z0-9]{12,32}$/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', '7z', 'rar']);

type AttachmentIndex = {
  version: 1;
  attachments: SessionAttachment[];
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
function indexPath(cwd: string) { return workspaceMetadataPath(cwd, '.tau/attachments.json'); }

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
  const parsed = readJsonObject(indexPath(cwd), { version: INDEX_VERSION, attachments: [] });
  if ('messageRefs' in parsed) throw Object.assign(error('Attachment associations require workspace migration.', 409), { code: 'workspace_migration_required' });
  if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.attachments)) throw error('Unsupported or corrupt attachment index', 409);
  return { version: INDEX_VERSION, attachments: parsed.attachments as SessionAttachment[] };
}

function writeIndex(cwd: string, index: AttachmentIndex) {
  assertNotSymlink(tauDir(cwd));
  assertNotSymlink(indexPath(cwd));
  writeJsonAtomic(indexPath(cwd), index);
}

function ensureWithin(root: string, target: string) {
  // Stricter than isWithin(): the attachment root itself is not a valid target.
  if (path.resolve(root) === path.resolve(target) || !isWithin(root, target)) throw error('Attachment path escapes the session directory', 403);
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
  if (state.size > MAX_ATTACHMENT_BYTES) {
    throw error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit\nPlease provide the file's path.`, 413);
  }
  hash.update(chunk);
  await handle.write(chunk);
}

async function parseMultipart(req: IncomingMessage, tempDir: string): Promise<MultipartFile[]> {
  const contentType = String(req.headers['content-type'] || '');
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw error('Expected multipart/form-data upload', 415);
  if ((boundaryMatch[1] || boundaryMatch[2]).length > 200) throw error('Multipart boundary is too large');
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const dataBoundary = Buffer.from(`\r\n${boundary.toString()}`);
  let buffer = Buffer.alloc(0);
  let state: 'preamble' | 'delimiter' | 'headers' | 'data' | 'done' = 'preamble';
  let current: { name: string; mimeType: string; path: string; handle: fsp.FileHandle; hash: crypto.Hash; stats: { size: number } } | null = null;
  const files: MultipartFile[] = [];
  const discardCurrent = async () => {
    if (!current) return;
    await current.handle.close();
    current = null;
  };
  const closeCurrent = async () => {
    if (!current) return;
    await current.handle.close();
    files.push({ name: current.name, mimeType: current.mimeType, tempPath: current.path, size: current.stats.size, sha256: current.hash.digest('hex') });
    current = null;
  };
  const consume = async (chunk: Buffer) => {
    if (state === 'done') return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (state === 'preamble') {
        const index = buffer.indexOf(boundary);
        if (index < 0) { buffer = buffer.slice(Math.max(0, buffer.length - boundary.length)); return; }
        buffer = buffer.slice(index + boundary.length);
        state = 'delimiter';
      } else if (state === 'delimiter') {
        if (buffer.length < 2) return;
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) { state = 'done'; buffer = Buffer.alloc(0); return; }
        if (!buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) throw error('Malformed multipart boundary');
        buffer = buffer.slice(2); state = 'headers';
      } else if (state === 'headers') {
        const end = buffer.indexOf(Buffer.from('\r\n\r\n'));
        if (end < 0) { if (buffer.length > 64 * 1024) throw error('Multipart headers are too large'); return; }
        if (end > 64 * 1024) throw error('Multipart headers are too large');
        const headerText = buffer.slice(0, end).toString('utf8');
        const disposition = headerText.match(/content-disposition:\s*[^\r\n]*/i)?.[0] || '';
        const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
        if (filename !== undefined) {
          if (files.length >= MAX_UPLOAD_FILES) throw error(`Upload exceeds the ${MAX_UPLOAD_FILES} file limit`, 413);
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
        state = 'delimiter';
      } else return;
    }
  };
  let failure: Error | null = null;
  let receivedBytes = 0;
  try {
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (failure) continue; // Drain without retaining any more request bytes.
      try {
        if (receivedBytes > MAX_UPLOAD_BYTES) throw error('Upload exceeds the 100 MB total limit\nPlease provide the file\'s path.', 413);
        await consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (cause) {
        failure = cause as Error;
        buffer = Buffer.alloc(0);
        await discardCurrent();
      }
    }
    if (failure) throw failure;
    if ((state as string) !== 'done' || current) throw error('Incomplete multipart upload', 400);
    return files;
  } finally {
    await discardCurrent();
  }
}

export async function saveUploadedAttachments(cwd: string, req: IncomingMessage, source: SessionAttachmentSource, conversationId: string) {
  conversationStatePath({ cwd, conversationId });
  assertNotSymlink(tauDir(cwd));
  assertNotSymlink(sessionAttachmentsDir(cwd));
  fs.mkdirSync(sessionAttachmentsDir(cwd), { recursive: true, mode: 0o700 });
  const tempRoot = path.join(tauDir(cwd), 'attachment-tmp');
  assertNotSymlink(tempRoot);
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'request-'));
  const created: SessionAttachment[] = [];
  const createdDirs: string[] = [];
  let release: (() => void) | undefined;
  try {
    const files = await parseMultipart(req, tempDir);
    if (!files.length) throw error('No file was provided', 400);
    release = acquireWriteLease(indexPath(cwd));
    // Commit the fresh index in one synchronous segment after parsing finishes.
    const index = readIndex(cwd);
    for (const file of files) {
      const id = makeId();
      const dir = path.join(sessionAttachmentsDir(cwd), id);
      const target = path.join(dir, file.name);
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      createdDirs.push(dir);
      ensureWithin(sessionAttachmentsDir(cwd), dir);
      fs.renameSync(file.tempPath, target);
      const attachment: SessionAttachment = { id, name: file.name, relativePath: relativePosixPath(cwd, target), mimeType: file.mimeType, size: file.size, sha256: file.sha256, kind: kindFor(file.name, file.mimeType), source, sourceConversationId: conversationId, status: 'ready', createdAt: new Date().toISOString() };
      index.attachments.push(attachment); created.push(attachment);
    }
    writeIndex(cwd, index);
    return created;
  } catch (cause) {
    for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
    throw cause;
  } finally {
    release?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function deleteSessionAttachment(cwd: string, id: string) {
  assertNotSymlink(sessionAttachmentsDir(cwd));
  const release = acquireWriteLease(indexPath(cwd));
  try {
    const index = readIndex(cwd);
    const attachment = index.attachments.find((item) => item.id === id);
    if (!attachment) throw error('Attachment not found', 404);
    const privateRoot = path.join(tauDir(cwd), 'conversations');
    assertNotSymlink(privateRoot);
    if (fs.existsSync(privateRoot)) for (const entry of fs.readdirSync(privateRoot, { withFileTypes: true })) {
      if (!CONVERSATION_ID.test(entry.name)) continue;
      if (readAttachmentMessageRefs(cwd, entry.name).some((ref) => ref.attachmentIds.includes(id))) throw error('Attachment is already used by a conversation message', 409);
    }
    const dir = path.resolve(cwd, path.dirname(attachment.relativePath));
    ensureWithin(sessionAttachmentsDir(cwd), dir);
    assertNotSymlink(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    index.attachments = index.attachments.filter((item) => item.id !== id);
    writeIndex(cwd, index);
  } finally { release(); }
}

export function readAttachmentMessageRefs(cwd: string, conversationId: string): AttachmentMessageRef[] {
  const file = conversationStatePath({ cwd, conversationId }, 'attachment-message-refs.json');
  const value = readJsonObject(file, { version: 1, refs: [] });
  if (value.version !== 1 || !Array.isArray(value.refs) || !value.refs.every((ref) => ref && typeof ref === 'object' && typeof ref.text === 'string' && Array.isArray(ref.attachmentIds) && ref.attachmentIds.every((id: unknown) => typeof id === 'string' && ATTACHMENT_ID_RE.test(id)))) throw Object.assign(error('Attachment message reference metadata is corrupt.', 409), { code: 'metadata_corrupt' });
  return value.refs;
}

export function recordAttachmentMessageRefs(cwd: string, conversationId: string, ref: AttachmentMessageRef) {
  const release = acquireWriteLease(indexPath(cwd));
  try {
    const refs = readAttachmentMessageRefs(cwd, conversationId);
    const key = `${ref.timestamp || ''}\n${ref.text}`;
    const existing = refs.findIndex((item) => `${item.timestamp || ''}\n${item.text}` === key);
    if (existing >= 0) refs[existing] = ref; else refs.push(ref);
    writeJsonAtomic(conversationStatePath({ cwd, conversationId }, 'attachment-message-refs.json'), { version: 1, refs });
  } finally { release(); }
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
