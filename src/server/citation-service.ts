import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

import type {
  CitationContainerType,
  CitationEnvelope,
  CitationLocator,
  CitationOccurrence,
  CitationResourceKind,
  CitationRole,
  CitationWork,
} from '../contracts/index.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import { resolveSessionAttachments } from './session-attachments.js';
import { CitationRegistryStore, newCitationId } from './citation-registry.js';
import { isWithin, relativePosixPath } from './util/path.js';

export type CitationServiceSession = { id: string; cwd: string; citationRegistryId?: string; resolvedSessionPlan?: ResolvedSessionPlan | null };
type KnowledgeResult = {
  knowledge_id: string;
  doc_id: string;
  title: string;
  statement: string;
  document_class: string;
  normative_force: string;
  verification_status: string;
  issuer?: string;
  source: { asset_id: string; kind: Extract<CitationResourceKind, 'pdf' | 'document' | 'image'>; mime_type: string; relative_path: string; sha256: string };
  source_refs: Array<{ node_id?: string; pdf_page?: number; printed_page?: string; source_unit?: string; line_start?: number; line_end?: number }>;
};
export type CitationArtifactInput = { path: string; title?: string; quote?: string; section?: string; page?: number; lineStart?: number; lineEnd?: number; derivedFromResourceIds?: string[] };
export type CitationDatasetInput = { path: string; assetId: string; version?: string; querySummary?: string; timeRange?: string; title?: string };

function hash(value: Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function timestamp() { return new Date().toISOString(); }

function citekeyFor(title: string, standardNumber: string | undefined, existing: Set<string>) {
  const raw = (standardNumber || title).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 72) || 'source';
  let citekey = raw;
  for (let suffix = 2; existing.has(citekey); suffix += 1) citekey = `${raw}_${suffix}`;
  return citekey;
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
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
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

function mimeFor(filePath: string): [CitationResourceKind, string] {
  const extension = path.extname(filePath).toLowerCase();
  const values: Record<string, [CitationResourceKind, string]> = {
    '.pdf': ['pdf', 'application/pdf'], '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.gif': ['image', 'image/gif'], '.webp': ['image', 'image/webp'], '.svg': ['image', 'image/svg+xml'], '.md': ['document', 'text/markdown'], '.txt': ['document', 'text/plain'], '.html': ['document', 'text/html'], '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], '.pptx': ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'], '.csv': ['dataset', 'text/csv'], '.tsv': ['dataset', 'text/tab-separated-values'], '.xlsx': ['dataset', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], '.xls': ['dataset', 'application/vnd.ms-excel'], '.json': ['dataset', 'application/json'], '.jsonl': ['dataset', 'application/x-ndjson'],
  };
  const result = values[extension];
  if (!result) throw new Error(`Unsupported citation resource type: ${extension || 'unknown'}`);
  return result;
}

function envelopeFromRegistry(registry: ReturnType<CitationRegistryStore['load']>): CitationEnvelope {
  const { protocol, version, citationSetId, generatedAt, works, resources, locators, occurrences, provenance } = registry;
  return { protocol, version, citationSetId, generatedAt, works, resources, locators, occurrences, provenance };
}

function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function yamlScalar(filePath: string, key: string) {
  const match = fs.readFileSync(filePath, 'utf8').match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return undefined;
  return match[1].replace(/^['"]|['"]$/g, '').trim() || undefined;
}

function resolveKnowledgeFile(root: string, relativePath: string, label: string) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Knowledge ${label} path is invalid.`);
  const requested = path.resolve(root, relativePath);
  if (!isWithin(root, requested) || fs.lstatSync(requested).isSymbolicLink()) throw new Error(`Knowledge ${label} path is outside the selected asset.`);
  const resolved = fs.realpathSync(requested);
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Knowledge ${label} is unavailable.`);
  return resolved;
}

function resolveKnowledgeResultFromAsset(knowledgeRoot: string, assetId: string, knowledgeId: string): KnowledgeResult {
  const root = fs.realpathSync(knowledgeRoot);
  const documents = readJsonLines(resolveKnowledgeFile(root, '_catalog/documents.jsonl', 'catalog'));
  for (const document of documents) {
    if (document.validation_status !== 'accepted' || typeof document.doc_id !== 'string' || typeof document.path !== 'string') continue;
    const dataPath = resolveKnowledgeFile(root, `${document.path}/data/knowledge.jsonl`, 'index');
    const item = readJsonLines(dataPath).find((candidate) => candidate.knowledge_id === knowledgeId);
    if (!item) continue;
    const documentRoot = path.join(root, document.path);
    const metadataPath = resolveKnowledgeFile(root, `${document.path}/document.yaml`, 'metadata');
    const sourceFile = typeof item.source_file === 'string' ? item.source_file : yamlScalar(metadataPath, 'source_file');
    if (!sourceFile) throw new Error(`Knowledge source file is missing: ${knowledgeId}`);
    const sourcePath = resolveKnowledgeFile(documentRoot, sourceFile, 'source');
    const sha256 = hash(fs.readFileSync(sourcePath));
    const expectedSha256 = yamlScalar(metadataPath, 'source_sha256');
    if (expectedSha256 && expectedSha256 !== sha256) throw new Error(`Knowledge source hash mismatch: ${sourcePath}`);
    const [resolvedKind, mimeType] = mimeFor(sourcePath);
    if (resolvedKind !== 'pdf' && resolvedKind !== 'document' && resolvedKind !== 'image') throw new Error(`Knowledge source type is unsupported: ${sourcePath}`);
    const sourceRefs = Array.isArray(item.source_refs) ? item.source_refs.filter((ref): ref is Record<string, unknown> => !!ref && typeof ref === 'object').map((ref) => ({
      ...(typeof ref.node_id === 'string' ? { node_id: ref.node_id } : {}),
      ...(typeof ref.pdf_page === 'number' ? { pdf_page: ref.pdf_page } : {}),
      ...(typeof ref.printed_page === 'string' || typeof ref.printed_page === 'number' ? { printed_page: String(ref.printed_page) } : {}),
      ...(typeof ref.source_unit === 'string' ? { source_unit: ref.source_unit } : {}),
      ...(typeof ref.line_start === 'number' ? { line_start: ref.line_start } : {}),
      ...(typeof ref.line_end === 'number' ? { line_end: ref.line_end } : {}),
    })) : [];
    return {
      knowledge_id: knowledgeId,
      doc_id: String(document.doc_id),
      title: typeof document.title === 'string' ? document.title : String(document.doc_id),
      statement: typeof item.statement === 'string' ? item.statement : '',
      document_class: typeof document.document_class === 'string' ? document.document_class : 'knowledge',
      normative_force: typeof item.normative_force === 'string' ? item.normative_force : '',
      verification_status: typeof item.verification_status === 'string' ? item.verification_status : '',
      ...(yamlScalar(metadataPath, 'issuer') ? { issuer: yamlScalar(metadataPath, 'issuer') } : {}),
      source: { asset_id: assetId, kind: resolvedKind, mime_type: mimeType, relative_path: relativePosixPath(root, sourcePath), sha256 },
      source_refs: sourceRefs,
    };
  }
  throw new Error(`Knowledge item not found: ${knowledgeId}`);
}

function resolveKnowledgeResult(session: CitationServiceSession, knowledgeId: string): KnowledgeResult {
  const assets = session.resolvedSessionPlan?.assets.filter((asset) => asset.kind === 'knowledge') || [];
  if (!assets.length) throw new Error('The active session has no knowledge assets.');
  const matches: KnowledgeResult[] = [];
  for (const asset of assets) {
    try { matches.push(resolveKnowledgeResultFromAsset(asset.path, asset.id, knowledgeId)); }
    catch (error) {
      if (error instanceof Error && error.message === `Knowledge item not found: ${knowledgeId}`) continue;
      throw error;
    }
  }
  if (!matches.length) throw new Error(`Knowledge item not found in active assets: ${knowledgeId}`);
  if (matches.length > 1) throw new Error(`Knowledge item is ambiguous across active assets: ${knowledgeId}`);
  return matches[0];
}

export class CitationService {
  constructor() {}

  registry(session: CitationServiceSession) { return new CitationRegistryStore(session.cwd, session.citationRegistryId || session.id); }

  private register(session: CitationServiceSession, draft: CitationEnvelope) {
    return envelopeFromRegistry(this.registry(session).register(draft));
  }

  private workAndResource(session: CitationServiceSession, input: { title: string; type: string; scope: 'knowledge' | 'attachment' | 'artifact' | 'web' | 'dataset'; kind: CitationResourceKind; relativePath: string; mimeType: string; sha256: string; issuer?: string; standardNumber?: string; sourceUrl?: string }, pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>()) {
    const pendingKey = `${input.scope}:${input.relativePath}:${input.sha256}`;
    const alreadyPending = pending.get(pendingKey);
    if (alreadyPending) return alreadyPending;
    const registry = this.registry(session).load();
    const resource = registry.resources.find((item) => item.scope === input.scope && item.relativePath === input.relativePath && item.sha256 === input.sha256);
    if (resource) {
      const work = registry.works.find((item) => item.workId === resource.workId);
      if (!work) throw new Error(`Citation registry resource ${resource.resourceId} has no work.`);
      const entry = { work, resource };
      pending.set(pendingKey, entry);
      return entry;
    }
    const work: CitationWork = { workId: newCitationId('work'), citekey: citekeyFor(input.title, input.standardNumber, new Set(registry.works.flatMap((item) => item.citekey ? [item.citekey] : []))), type: input.type, title: input.title, ...(input.issuer ? { issuer: input.issuer } : {}), ...(input.standardNumber ? { standardNumber: input.standardNumber } : {}) };
    const entry = { work, resource: { resourceId: newCitationId('resource'), workId: work.workId, scope: input.scope, kind: input.kind, relativePath: input.relativePath, mimeType: input.mimeType, sha256: input.sha256, acquiredAt: timestamp(), ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) } };
    pending.set(pendingKey, entry);
    return entry;
  }

  resolveKnowledge(session: CitationServiceSession, knowledgeIds: string[]) {
    const ids = [...new Set(knowledgeIds)];
    if (!ids.length || ids.length > 80 || ids.some((id) => !/^K-[A-Za-z0-9_.-]+-\d{6}$/.test(id))) throw new Error('knowledgeIds must contain 1–80 verified knowledge IDs.');
    const sources = ids.map((knowledgeId) => resolveKnowledgeResult(session, knowledgeId));
    const works = [], resources = [], locators: CitationLocator[] = [];
    const pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>();
    for (const source of sources) {
      if (!source.source_refs.length) throw new Error(`Knowledge item has no citation locator: ${source.knowledge_id}`);
      const entry = this.workAndResource(session, { title: source.title, type: source.document_class || 'knowledge', scope: 'knowledge', kind: source.source.kind, relativePath: `${source.source.asset_id}/${source.source.relative_path}`, mimeType: source.source.mime_type, sha256: source.source.sha256, issuer: source.issuer, standardNumber: source.doc_id }, pending);
      works.push(entry.work); resources.push(entry.resource);
      for (const ref of source.source_refs) locators.push({ locatorId: newCitationId('locator'), resourceId: entry.resource.resourceId, quote: source.statement, ...(ref.node_id ? { nodeId: ref.node_id } : {}), ...(ref.pdf_page ? { page: ref.pdf_page } : {}), ...(ref.printed_page ? { printedPage: String(ref.printed_page) } : {}), ...(ref.source_unit ? { sourceUnit: ref.source_unit } : {}), ...(ref.line_start ? { lineStart: ref.line_start } : {}), ...(ref.line_end ? { lineEnd: ref.line_end } : {}) });
    }
    return this.register(session, { protocol: 'pi-citation', version: '2.0', citationSetId: newCitationId('set'), generatedAt: timestamp(), works, resources, locators, occurrences: [], provenance: [] });
  }

  resolveAttachments(session: CitationServiceSession, attachmentIds: string[]) {
    const attachments = resolveSessionAttachments(session.cwd, [...new Set(attachmentIds)]);
    const works = [], resources = [], locators: CitationLocator[] = [];
    const pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>();
    for (const attachment of attachments) {
      const resolved = path.resolve(session.cwd, attachment.relativePath);
      const [kind] = mimeFor(resolved);
      const entry = this.workAndResource(session, { title: attachment.name, type: 'attachment', scope: 'attachment', kind, relativePath: attachment.relativePath, mimeType: attachment.mimeType, sha256: attachment.sha256 }, pending);
      works.push(entry.work); resources.push(entry.resource); locators.push({ locatorId: newCitationId('locator'), resourceId: entry.resource.resourceId });
    }
    return this.register(session, { protocol: 'pi-citation', version: '2.0', citationSetId: newCitationId('set'), generatedAt: timestamp(), works, resources, locators, occurrences: [], provenance: [] });
  }

  resolveArtifacts(session: CitationServiceSession, artifacts: CitationArtifactInput[]) {
    if (!artifacts.length || artifacts.length > 20) throw new Error('artifacts must contain 1–20 task resources.');
    const root = fs.realpathSync(session.cwd);
    const works = [], resources = [], locators: CitationLocator[] = [], provenance = [];
    const pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>();
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path)) throw new Error('Citation artifact path must be relative to the active session.');
      const requested = path.resolve(root, artifact.path);
      if (!isWithin(root, requested) || fs.lstatSync(requested).isSymbolicLink()) throw new Error(`Citation artifact is outside the active task: ${artifact.path}`);
      const resolved = fs.realpathSync(requested);
      if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Citation artifact is outside the active task: ${artifact.path}`);
      const [kind, mimeType] = mimeFor(resolved);
      const sha256 = hash(fs.readFileSync(resolved));
      const relativePath = relativePosixPath(root, resolved);
      const entry = this.workAndResource(session, { title: artifact.title?.trim() || path.basename(resolved), type: 'artifact', scope: 'artifact', kind, relativePath, mimeType, sha256 }, pending);
      works.push(entry.work); resources.push(entry.resource);
      locators.push({ locatorId: newCitationId('locator'), resourceId: entry.resource.resourceId, ...(artifact.quote?.trim() ? { quote: artifact.quote.trim() } : {}), ...(artifact.section?.trim() ? { section: artifact.section.trim() } : {}), ...(artifact.page ? { page: artifact.page } : {}), ...(artifact.lineStart ? { lineStart: artifact.lineStart } : {}), ...(artifact.lineEnd ? { lineEnd: artifact.lineEnd } : {}) });
      for (const sourceId of artifact.derivedFromResourceIds || []) provenance.push({ provenanceId: newCitationId('provenance'), fromResourceId: entry.resource.resourceId, toResourceId: sourceId, relation: 'derived-from' as const, generatedAt: timestamp() });
    }
    return this.register(session, { protocol: 'pi-citation', version: '2.0', citationSetId: newCitationId('set'), generatedAt: timestamp(), works, resources, locators, occurrences: [], provenance });
  }

  resolveDatasets(session: CitationServiceSession, datasets: CitationDatasetInput[]) {
    if (!datasets.length || datasets.length > 20) throw new Error('datasets must contain 1–20 controlled result files.');
    const root = fs.realpathSync(session.cwd), works = [], resources = [], locators: CitationLocator[] = [];
    const pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>();
    for (const dataset of datasets) {
      if (!dataset || typeof dataset.path !== 'string' || path.isAbsolute(dataset.path) || !/^[A-Za-z0-9_.:-]{1,180}$/.test(dataset.assetId)) throw new Error('Dataset citation requires a safe assetId and session-relative result path.');
      const requested = path.resolve(root, dataset.path);
      if (!isWithin(root, requested) || fs.lstatSync(requested).isSymbolicLink()) throw new Error(`Dataset result is outside the active task: ${dataset.path}`);
      const resolved = fs.realpathSync(requested);
      if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Dataset result is outside the active task: ${dataset.path}`);
      const [, mimeType] = mimeFor(resolved), sha256 = hash(fs.readFileSync(resolved)), relativePath = relativePosixPath(root, resolved);
      const label = dataset.title?.trim() || `数据结果 ${dataset.assetId}`;
      const entry = this.workAndResource(session, { title: label, type: 'dataset', scope: 'dataset', kind: 'dataset', relativePath, mimeType, sha256, standardNumber: dataset.version }, pending);
      works.push(entry.work); resources.push(entry.resource);
      locators.push({ locatorId: newCitationId('locator'), resourceId: entry.resource.resourceId, sourceUnit: [dataset.assetId, dataset.version, dataset.timeRange, dataset.querySummary].filter(Boolean).join(' · ') || dataset.assetId });
    }
    return this.register(session, { protocol: 'pi-citation', version: '2.0', citationSetId: newCitationId('set'), generatedAt: timestamp(), works, resources, locators, occurrences: [], provenance: [] });
  }

  async resolveWeb(session: CitationServiceSession, urls: string[]) {
    const unique = [...new Set(urls)];
    if (!unique.length || unique.length > 10) throw new Error('webUrls must contain 1–10 URLs.');
    const works = [], resources = [], locators: CitationLocator[] = [];
    const pending = new Map<string, { work: CitationWork; resource: CitationEnvelope['resources'][number] }>();
    for (const rawUrl of unique) {
      const target = await publicCitationTarget(rawUrl);
      const response = await fetchPinnedPublicCitation(target);
      const mimeType = response.headers['content-type']?.split(';')[0].trim().toLowerCase() || '';
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300 || !mimeType.startsWith('text/')) { response.resume(); throw new Error(`Web citation fetch failed: ${target.url.hostname}`); }
      const body = await readWebSnapshot(response);
      const sha256 = hash(body), fileName = `${sha256}.html`, relativePath = `.tau/citation-snapshots/${fileName}`;
      const snapshotPath = path.join(session.cwd, relativePath);
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(snapshotPath, body, { mode: 0o600 });
      const title = target.url.hostname;
      const entry = this.workAndResource(session, { title, type: 'webpage', scope: 'web', kind: 'web', relativePath, mimeType: 'text/html', sha256, sourceUrl: rawUrl }, pending);
      works.push(entry.work); resources.push(entry.resource); locators.push({ locatorId: newCitationId('locator'), resourceId: entry.resource.resourceId, sourceUnit: rawUrl });
    }
    return this.register(session, { protocol: 'pi-citation', version: '2.0', citationSetId: newCitationId('set'), generatedAt: timestamp(), works, resources, locators, occurrences: [], provenance: [] });
  }

  cite(session: CitationServiceSession, input: { locatorId: string; containerType: CitationContainerType; containerId: string; anchorId?: string; role?: CitationRole }) {
    const store = this.registry(session);
    const registry = store.load();
    if (!registry.locators.some((item) => item.locatorId === input.locatorId)) throw new Error('Citation locator is not registered for this session.');
    const occurrence: CitationOccurrence = { occurrenceId: newCitationId('occurrence'), locatorId: input.locatorId, containerType: input.containerType, containerId: input.containerId, ...(input.anchorId ? { anchorId: input.anchorId } : {}), ...(input.role ? { role: input.role } : {}) };
    registry.occurrences.push(occurrence);
    registry.updatedAt = timestamp();
    return { occurrence, envelope: envelopeFromRegistry(store.save(registry)) };
  }
}
