import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isWithin } from './util/path.js';
import type { PiRpcSession } from './sessions.js';
import { validateToolRequest } from './tool-request.js';

type RecordValue = Record<string, unknown>;
const fail = (
  message: string,
  commit: 'not_started' | 'unknown' = 'not_started'
) =>
  Object.assign(new Error(message), {
    status: 400,
    code: 'experience_exchange_failed',
    phase: 'experience',
    commit,
  });
const obj = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const reference = (value: unknown) => {
  if (!obj(value)) return null;
  const { release_id, entry_id, collection_id, revision, digest } = value;
  return typeof release_id === 'string' &&
    !!release_id &&
    typeof entry_id === 'string' &&
    !!entry_id &&
    typeof collection_id === 'string' &&
    !!collection_id &&
    Number.isInteger(revision) &&
    (revision as number) >= 0 &&
    typeof digest === 'string' &&
    !!digest
    ? { release_id, entry_id, collection_id, revision, digest }
    : null;
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : obj(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
const equalRef = (a: unknown, b: unknown) =>
  JSON.stringify(reference(a)) === JSON.stringify(reference(b)) &&
  reference(a) !== null;
export function experienceConfig() {
  const raw = process.env.TRANSPORTX_EXPERIENCE_MCP_URL || '';
  const tokenFile = process.env.TRANSPORTX_EXPERIENCE_TOKEN_FILE || '';
  const scope = process.env.TRANSPORTX_EXPERIENCE_SCOPE || '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail('Experience Exchange is not configured on the Host.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/mcp/experience' ||
    !path.isAbsolute(tokenFile) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(scope)
  )
    throw fail('Invalid Experience Exchange Host configuration.');
  let token: string;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    throw fail('Experience Exchange credential is unavailable.');
  }
  if (!token || /[\r\n]/.test(token))
    throw fail('Experience Exchange credential is invalid.');
  return { url, token, scope };
}
const RECEIPT_LIMIT = 16 * 1024 * 1024;
function receiptFile(session: PiRpcSession) {
  const root = fs.realpathSync(session.cwd);
  let current = root;
  for (const name of ['.transportx', 'experience-exchange']) {
    current = path.join(current, name);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isWithin(root, fs.realpathSync(current))
    )
      throw fail('Unsafe experience receipt directory.');
  }
  return path.join(current, 'receipts.jsonl');
}
function openReceipt(file: string, flags: number) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > RECEIPT_LIMIT ||
      fs.lstatSync(file).isSymbolicLink() ||
      !isWithin(fs.realpathSync(path.dirname(file)), fs.realpathSync(file))
    )
      throw fail('Unsafe or oversized experience receipt.');
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function receipts(file: string): RecordValue[] {
  let fd: number;
  try {
    fd = openReceipt(file, fs.constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buffer, offset, size - offset, offset);
      if (!n) throw fail('Experience receipt changed while reading.');
      offset += n;
    }
    return buffer
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (!obj(value)) throw fail('Experience receipt is invalid.');
        return value;
      });
  } finally {
    fs.closeSync(fd);
  }
}
function append(file: string, value: RecordValue) {
  const line =
    JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n';
  const fd = openReceipt(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
  );
  try {
    if (fs.fstatSync(fd).size + Buffer.byteLength(line) > RECEIPT_LIMIT)
      throw fail('Experience receipt limit reached.');
    fs.writeFileSync(fd, line, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
/** Validate against the approved contract, retaining the frozen v1 search interface. */
export async function validateExperienceRequest(
  session: PiRpcSession,
  kind: 'search' | 'feedback',
  body: RecordValue
): Promise<RecordValue> {
  const legacy = kind === 'search' && body.contractVersion === '1.0.0' &&
    session.resolvedSessionPlan?.modules.some(module => module.id === 'com.transportx.experience-exchange' && module.version === '1.0.0');
  const compatible = legacy ? {
    contractVersion: '1.0.0',
    input: (await import('../contracts/experience-lookup.mjs')).LegacyExperienceSearchSchema,
  } : undefined;
  const input = await validateToolRequest('com.transportx.experience-exchange', body, `experience.${kind}`, compatible);
  if (kind === 'search' && !legacy) input.limit = 3;
  return input;
}
export async function exchange(
  session: PiRpcSession,
  kind: 'search' | 'feedback',
  input: RecordValue,
  signal?: AbortSignal,
  toolCallId?: string
): Promise<RecordValue> {
  const cfg = experienceConfig();
  const file = receiptFile(session);
  const prior = receipts(file);
  if (
    kind === 'search' &&
    (typeof input.query !== 'string' ||
      Buffer.byteLength(input.query, 'utf8') > 2000)
  )
    throw fail('Invalid search query.');
  if (kind === 'feedback') {
    for (const key of [
      'submission_id',
      'run_id',
      'question',
      'initial_interpretation',
      'correction',
      'evidence_ref',
    ]) {
      const value = input[key];
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        Buffer.byteLength(value, 'utf8') > 8000 ||
        (key === 'submission_id' && /[\x00-\x1f\x7f]/.test(value))
      )
        throw fail(`Invalid feedback ${key}.`);
    }
    if (
      Array.isArray(input.data_refs) &&
      (input.data_refs.length > 32 ||
        input.data_refs.some(
          (value) =>
            typeof value !== 'string' ||
            !value.trim() ||
            Buffer.byteLength(value, 'utf8') > 1000
        ))
    )
      throw fail('Invalid feedback data_refs.');
    if (
      input.experience !== undefined &&
      (!reference(input.experience) ||
        !prior.some(
          (receipt) =>
            receipt.kind === 'search' &&
            receipt.scope === cfg.scope &&
            obj(receipt.result) &&
            Array.isArray(receipt.result.experiences) &&
            receipt.result.experiences.some((item: unknown) =>
              equalRef(item, input.experience)
            )
        ))
    )
      throw fail(
        'Feedback experience must exactly match an experience returned in this workspace. Select it only if actually used.'
      );
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical(input)))
      .digest('hex');
    const previous = prior.find(
      (r) =>
        r.kind === 'feedback-pending' &&
        r.scope === cfg.scope &&
        r.submission_id === input.submission_id
    );
    if (previous && previous.fingerprint !== fingerprint)
      throw fail(
        'This submission_id was already used with a different payload.'
      );
    if (!previous)
      append(file, {
        kind: 'feedback-pending',
        scope: cfg.scope,
        submission_id: input.submission_id,
        fingerprint,
      });
  }
  let result: RecordValue;
  try {
    result = await callExperienceMcp(kind === 'search' ? 'search_experience' : 'submit_experience_feedback', input, signal);
    if (result.scope !== cfg.scope) throw new Error('Scope mismatch');
    if (kind === 'search') {
      if (
        !Array.isArray(result.experiences) ||
        typeof result.truncated !== 'boolean' ||
        result.experiences.length >
          (typeof input.limit === 'number' ? input.limit : 10) ||
        !result.experiences.every(
          (item: unknown) =>
            obj(item) &&
            reference(item) &&
            item.scope === cfg.scope &&
            typeof item.title === 'string' &&
            typeof item.body === 'string' &&
            Array.isArray(item.source_ids) &&
            item.source_ids.every((id: unknown) => typeof id === 'string')
        )
      )
        throw new Error('Invalid search result');
      if (
        obj(input.reference) &&
        (result.experiences.length > 1 ||
          !result.experiences.every(
            (item: RecordValue) =>
              item.release_id === (input.reference as RecordValue).release_id &&
              item.entry_id === (input.reference as RecordValue).entry_id
          ))
      )
        throw new Error('Reference mismatch');
    }
    if (
      kind === 'feedback' &&
      (typeof result.feedback_id !== 'string' ||
        typeof result.status !== 'string')
    )
      throw new Error('Invalid feedback result');
  } catch {
    throw fail(
      kind === 'feedback'
        ? 'Feedback outcome is unconfirmed. Retry the identical payload with the same submission_id.'
        : 'Experience search failed or returned an invalid response.',
      kind === 'feedback' ? 'unknown' : 'not_started'
    );
  }
  try {
    append(file, {
      kind,
      scope: cfg.scope,
      ...(toolCallId ? { toolCallId } : {}),
      ...(kind === 'feedback' ? { request: input } : {}),
      result,
    });
  } catch {
    throw fail(
      kind === 'feedback'
        ? 'Feedback outcome is unconfirmed. Retry the identical payload with the same submission_id.'
        : 'Could not record the search receipt.',
      kind === 'feedback' ? 'unknown' : 'not_started'
    );
  }
  return result;
}

/** The credential and scope stay in the Host; tools cannot supply them. */
export async function callExperienceMcp(name: string, input: RecordValue, signal?: AbortSignal): Promise<RecordValue> {
  const cfg = experienceConfig();
  const client = new Client({ name: 'transportx-experience-exchange', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(cfg.url, {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}` }, redirect: 'error' },
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) }),
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name, arguments: input }, undefined, { signal, timeout: 30_000 });
    if (response.isError || !obj(response.structuredContent) || response.structuredContent.scope !== cfg.scope) throw new Error('Invalid or mismatched MCP result');
    return response.structuredContent;
  } finally { await client.close().catch(() => {}); }
}
