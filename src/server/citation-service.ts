import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { CITATION_PREVIEW_LIMIT, CITATION_PREVIEW_ROWS, isCitationInline, parseCitationLocator, publicCitationSource, type CitationDetail, type CitationEnvelope, type CitationEvidence, type CitationInline, type CitationLocator, type CitationMetadata, type CitationPreview, type CitationSourceVersion } from '../contracts/index.js';
import { parseDelimited } from '../contracts/delimited-table.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import { isWithin } from './util/path.js';
import { CitationRegistryStore } from './citation-registry.js';
import { hashCitationFile, locateCitationFile, verifyCitationFile } from './citation-resources.js';
export type CitationServiceSession = { id: string; cwd: string; citationRegistryId?: string; resolvedSessionPlan?: ResolvedSessionPlan | null };
export type CitationInput = { path: string; assetId?: string; title?: string; locator: CitationLocator; contentKind: CitationEvidence['contentKind']; text?: string; metadata?: CitationMetadata; deliverable?: boolean };
function hash(value: string | Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function mimeFor(file: string) {
  const extension = path.extname(file).toLowerCase();
  const types: Record<string, string> = { '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  if (!types[extension]) throw new Error(`Unsupported citation file format: ${extension || 'unknown'}`);
  return types[extension];
}
function previewValue(value: CitationInline): CitationPreview {
  return typeof value === 'string' ? { kind: 'text', text: value, truncated: false } : { kind: 'table', table: value, truncated: false };
}
function previewFile(file: string, mime: string, locator?: CitationLocator): CitationPreview {
  const offset = locator?.kind === 'table' && locator.rowStart ? locator.rowStart - 1 : 0;
  const size = fs.statSync(file).size;
  if (size > CITATION_PREVIEW_LIMIT) return { kind: 'none', reason: '来源超过 2 MiB 预览限制，请打开原件查看。' };
  if (!mime.startsWith('text/') && !['application/json', 'application/x-ndjson'].includes(mime)) return { kind: 'none', reason: '此格式请在原件查看器中核对。' };
  const text = fs.readFileSync(file, 'utf8');
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') {
    const [columns = [], ...rows] = parseDelimited(text, mime === 'text/csv' ? ',' : '\t');
    if (columns.length && rows.every((row) => row.length === columns.length)) return { kind: 'table', table: { columns, rows: rows.slice(offset, offset + CITATION_PREVIEW_ROWS) }, rowStart: offset + 1, truncated: offset > 0 || rows.length > CITATION_PREVIEW_ROWS };
  }
  if (mime === 'application/json' || mime === 'application/x-ndjson') {
    try {
      const value: unknown = mime === 'application/json' ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      if (Array.isArray(value) && value.length && value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
        const columns = Object.keys(value[0] as Record<string, unknown>);
        if (columns.length && value.every((row) => Object.keys(row).length === columns.length && columns.every((key) => key in row && (row[key] === null || ['string', 'number', 'boolean'].includes(typeof row[key]))))) return { kind: 'table', table: { columns, rows: value.slice(offset, offset + CITATION_PREVIEW_ROWS).map((row) => columns.map((key) => row[key])) }, rowStart: offset + 1, truncated: offset > 0 || value.length > CITATION_PREVIEW_ROWS };
      }
    } catch { /* Irregular or non-JSON content remains safe text. */ }
  }
  const lines = text.split(/\r?\n/);
  let start = locator?.kind === 'document' && locator.lineStart ? locator.lineStart - 1 : 0;
  if (locator?.kind === 'document' && locator.section && mime === 'text/markdown') {
    const matches = lines.flatMap((line, index) => line.replace(/^#{1,6}\s+/, '').trim() === locator.section ? [index] : []);
    if (matches.length === 1) start = matches[0];
  }
  return { kind: 'text', text: lines.slice(start, start + CITATION_PREVIEW_ROWS).join('\n'), truncated: start > 0 || lines.length > CITATION_PREVIEW_ROWS };
}
export class CitationService {
  registry(session: CitationServiceSession) { return new CitationRegistryStore(session.cwd, session.citationRegistryId || session.id); }
  private evidence(source: CitationSourceVersion, input: Pick<CitationInput, 'locator' | 'contentKind' | 'text'>): CitationEvidence {
    const locator = parseCitationLocator(input.locator);
    if (!locator) throw new Error('Citation locator is invalid.');
    return { evidenceId: `e_${hash(JSON.stringify([source.sourceVersionId, locator, input.contentKind, input.text || '']))}`, sourceVersionId: source.sourceVersionId, locator, contentKind: input.contentKind, ...(input.text ? { text: input.text } : {}) };
  }
  resolve(session: CitationServiceSession, inputs: CitationInput[]): CitationEnvelope { return this.resolveFiles(session, inputs); }
  private resolveFiles(session: CitationServiceSession, inputs: CitationInput[], sourceKeys = new Map<string, string>()): CitationEnvelope {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error('sources must contain 1–20 specific original files or results.');
    const sources: CitationSourceVersion[] = [], evidence: CitationEvidence[] = [];
    const registry = this.registry(session).load();
    for (const input of inputs) {
      if (!input || typeof input.path !== 'string' || (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500)) || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 16000)) || !['excerpt', 'summary', 'result', 'source-only'].includes(input.contentKind)) throw new Error('A concrete source file is required; directory matches are candidates only.');
      const scope = input.assetId ? 'asset' as const : 'session' as const;
      const reference = { scope, ...(input.assetId ? { assetId: input.assetId } : {}), path: input.path };
      const { resolved, stat } = locateCitationFile(session, reference), sha256 = hashCitationFile(resolved);
      const sourceKey = sourceKeys.get(input.path) || `${scope}:${input.assetId || this.registry(session).sessionId}:${input.path}`;
      const sourceVersionId = `sv_${hash(JSON.stringify([sourceKey, sha256]))}`;
      const source: CitationSourceVersion = registry.sources.find((item) => item.sourceVersionId === sourceVersionId) || { sourceVersionId, sourceKey, title: input.title?.trim() || path.basename(resolved), acquiredAt: new Date().toISOString(), content: { kind: 'file', ...reference, mimeType: mimeFor(resolved), sha256, size: stat.size }, ...(input.metadata ? { metadata: input.metadata } : {}) };
      const item = this.evidence(source, input);
      // An excerpt is an independently checkable verbatim span, never a knowledge summary.
      if (input.contentKind === 'excerpt') {
        const preview = previewFile(resolved, mimeFor(resolved));
        let original = preview.kind === 'text' ? fs.readFileSync(resolved, 'utf8') : '';
        const locator = item.locator;
        if (locator.kind === 'document' && (locator.page || locator.printedPage)) original = '';
        if (locator.kind === 'document' && locator.lineStart) original = original.split(/\r?\n/).slice(locator.lineStart - 1, locator.lineEnd || locator.lineStart).join('\n');
        if (!input.text || !original.includes(input.text)) throw new Error('A verbatim excerpt must be verifiable at the fixed text location; otherwise use summary or source-only.');
      }
      if (!sources.some((value) => value.sourceVersionId === sourceVersionId)) sources.push(source);
      if (!evidence.some((value) => value.evidenceId === item.evidenceId)) evidence.push(item);
    }
    return this.registry(session).register({ protocol: 'pi-citation', version: '3.0', sources, evidence });
  }
  // Called only by Host producers after successful, validated execution; never exposed as Agent input.
  registerInline(session: CitationServiceSession, input: { sourceKey: string; title: string; value: CitationInline; locator: CitationLocator; executionRef: NonNullable<CitationSourceVersion['executionRef']> }): CitationEnvelope {
    if (!isCitationInline(input.value)) throw new Error('Inline citation exceeds 256 KiB or is not a bounded result.');
    const manifest = locateCitationFile(session, { scope: 'session', path: input.executionRef.path });
    if (hashCitationFile(manifest.resolved) !== input.executionRef.sha256) throw new Error('Execution manifest hash mismatch.');
    const value: CitationInline = typeof input.value === 'string' ? input.value : { columns: input.value.columns, rows: input.value.rows };
    const sha256 = hash(JSON.stringify(value)), sourceVersionId = `sv_${hash(JSON.stringify([input.sourceKey, sha256]))}`;
    const source: CitationSourceVersion = { sourceVersionId, sourceKey: input.sourceKey, title: input.title, acquiredAt: new Date().toISOString(), content: { kind: 'inline', sha256, value }, executionRef: input.executionRef };
    return this.registry(session).register({ protocol: 'pi-citation', version: '3.0', sources: [source], evidence: [this.evidence(source, { locator: input.locator, contentKind: 'result' })] });
  }
  registerSpatialResult(session: CitationServiceSession, result: import('../contracts/spatial.js').SpatialAnalysisResultV1) {
    const output = locateCitationFile(session, { scope: 'session', path: result.output.relativePath });
    if (hashCitationFile(output.resolved) !== result.output.sha256) throw new Error('Spatial result has changed.');
    const manifestPath = `.tau/spatial-results/${result.analysisId}/manifest.json`;
    const manifest = locateCitationFile(session, { scope: 'session', path: manifestPath });
    return this.registerInline(session, { sourceKey: `spatial:${this.registry(session).sessionId}:${result.analysisId}`, title: `空间分析 · ${result.operation}`, value: { columns: ['指标', '数量'], rows: [['输入要素', result.counts.input], ['输出要素', result.counts.output], ['未匹配', result.counts.unmatched], ['无效几何', result.counts.invalidGeometry], ['空几何', result.counts.emptyGeometry]] }, locator: { kind: 'result', field: 'counts' }, executionRef: { path: manifestPath, sha256: hashCitationFile(manifest.resolved), operation: result.operation, inputHashes: result.inputs.map((input) => input.sha256) } });
  }
  detail(session: CitationServiceSession, evidenceId: string): CitationDetail {
    const registry = this.registry(session).load(), evidence = registry.evidence.find((item) => item.evidenceId === evidenceId);
    const source = evidence && registry.sources.find((item) => item.sourceVersionId === evidence.sourceVersionId);
    if (!evidence || !source) throw Object.assign(new Error('Evidence not found in this session.'), { code: 'ENOENT' });
    const preview = source.content.kind === 'inline' && source.content.value !== undefined ? previewValue(source.content.value) : previewFile(verifyCitationFile(session, source).resolved, source.content.kind === 'file' ? source.content.mimeType : 'text/plain', evidence.locator);
    return { source: publicCitationSource(source), evidence, preview };
  }
  async resolveWeb(session: CitationServiceSession, urls: string[]) {
    if (!Array.isArray(urls) || !urls.length || urls.length > 10 || urls.some((url) => typeof url !== 'string')) throw new Error('webUrls must contain 1–10 public HTTPS URLs.');
    const inputs: CitationInput[] = [], sourceKeys = new Map<string, string>();
    for (const url of [...new Set(urls)]) {
      const target = await publicCitationTarget(url), response = await fetchPinnedPublicCitation(target);
      const mime = response.headers['content-type']?.split(';')[0].toLowerCase() || '';
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300 || !mime.startsWith('text/')) { response.resume(); throw new Error('Web citation fetch failed.'); }
      const body = await readWebSnapshot(response), relative = `.tau/citation-snapshots/${hash(target.url.href)}-${hash(body)}.html`;
      // Locate the parent through the same root boundary before writing snapshots.
      const directory = path.join(session.cwd, '.tau', 'citation-snapshots');
      fs.mkdirSync(directory, { recursive: true });
      const real = fs.realpathSync(directory);
      if (!isWithin(fs.realpathSync(session.cwd), real)) throw new Error('Citation snapshot directory is outside this session.');
      const snapshot = path.join(session.cwd, relative);
      if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, body, { mode: 0o600, flag: 'wx' });
      else if (fs.lstatSync(snapshot).isSymbolicLink() || hashCitationFile(snapshot) !== hash(body)) throw new Error('Citation snapshot is unsafe or has changed.');
      sourceKeys.set(relative, `web:${hash(target.url.href)}`);
      inputs.push({ path: relative, title: target.url.hostname, locator: { kind: 'source' }, contentKind: 'source-only', metadata: { url } });
    }
    return this.resolveFiles(session, inputs, sourceKeys);
  }
}

function isPrivateAddress(address: string) {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  return value.startsWith('::ffff:') || value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
}

type PublicCitationTarget = { url: URL; address: string; family: number };

async function publicCitationTarget(rawUrl: string): Promise<PublicCitationTarget> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Web citation URL is invalid.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || !hostname || url.username || url.password || isPrivateAddress(hostname)) throw new Error('Only public HTTPS URLs may be cited.');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Only public HTTPS URLs may be cited.');
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function publicCitationUrl(rawUrl: string) {
  return (await publicCitationTarget(rawUrl)).url;
}

function fetchPinnedPublicCitation(target: PublicCitationTarget) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.request({
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml' },
      servername: target.url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, resolve);
    request.setTimeout(10_000, () => request.destroy(new Error('Web citation fetch timed out.')));
    request.once('error', reject);
    request.end();
  });
}

async function readWebSnapshot(response: IncomingMessage) {
  const limit = 2 * 1024 * 1024;
  const contentLength = Number(response.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('Web citation snapshot exceeds 2 MB.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > limit) throw new Error('Web citation snapshot exceeds 2 MB.');
      chunks.push(chunk);
    }
  } finally {
    response.destroy();
  }
  return Buffer.concat(chunks);
}
