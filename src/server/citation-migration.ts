import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { citationRelativePath, parseCitationLocator, parseCitationRegistryStructured, CITATION_REGISTRY_LIMIT, type CitationRegistry, type CitationSourceVersion, type CitationEvidence, type CitationMetadata, type CitationFile } from '../contracts/index.js';
import { hashCitationFile, locateCitationFile } from './citation-resources.js';
import { isWithin } from './util/path.js';

type LegacyRegistry = {
  protocol: string; version: string; schemaVersion: number; sessionId: string; generatedAt: string;
  works: Array<CitationMetadata & { workId: string; title: string }>;
  resources: Array<{ resourceId: string; workId: string; scope: string; relativePath: string; mimeType: string; sha256: string; acquiredAt?: string; sourceUrl?: string }>;
  locators: Array<{ locatorId: string; resourceId: string; quote?: string; page?: number; printedPage?: string; section?: string; nodeId?: string; lineStart?: number; lineEnd?: number; clause?: string; table?: string; figure?: string; sourceUnit?: string }>;
  occurrences: Array<{ occurrenceId: string; locatorId: string }>;
  provenance: unknown[];
};
export type CitationMigrationPlan = {
  cwd: string; file: string; original: Buffer; registry: CitationRegistry;
  files: Array<{ resourceId: string; path: string; status: 'verified' | 'content-changed' | 'missing'; sizeBasis: string }>;
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function planCitationMigration(cwd: string): CitationMigrationPlan | null {
  const file = path.join(cwd, '.tau', 'citations.json');
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unsafe registry: ${file}`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > CITATION_REGISTRY_LIMIT) throw new Error(`Oversized or invalid registry: ${file}`);
  const original = fs.readFileSync(file);
  if (original.length > CITATION_REGISTRY_LIMIT) throw new Error(`Oversized registry: ${file}`);
  const old = JSON.parse(original.toString('utf8')) as LegacyRegistry;
  if (old.version === '3.0') {
    const parsed = parseCitationRegistryStructured(old);
    if (!parsed.ok) throw new Error(parsed.diagnostics[0].message);
    return null;
  }
  if (old.protocol !== 'pi-citation' || old.version !== '2.0' || old.schemaVersion !== 1 || !(['works', 'resources', 'locators', 'occurrences', 'provenance'] as const).every((key) => Array.isArray(old[key]))) throw new Error(`Unsupported registry: ${file}`);
  const migratedPlan = path.join(cwd, '.tau', 'resolved-session-plan.v3.json');
  const planFile = fs.existsSync(migratedPlan) ? migratedPlan : path.join(cwd, '.tau', 'resolved-session-plan.json');
  const session = { id: old.sessionId, cwd, resolvedSessionPlan: fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null };
  const works = new Map(old.works.map((item) => [item.workId, item]));
  const sourceIds = new Map<string, string>(), sources: CitationSourceVersion[] = [], evidence: CitationEvidence[] = [], files: CitationMigrationPlan['files'] = [];
  for (const resource of old.resources) {
    const work = works.get(resource.workId);
    if (!work || sourceIds.has(resource.resourceId)) throw new Error(`Invalid resource: ${resource.resourceId}`);
    const [assetId, ...segments] = resource.relativePath.split('/');
    if (!citationRelativePath(resource.relativePath) || !['knowledge', 'attachment', 'artifact', 'web', 'dataset'].includes(resource.scope)) throw new Error(`Citation path or scope is invalid: ${resource.resourceId}`);
    const reference: Pick<CitationFile, 'scope' | 'assetId' | 'path'> = resource.scope === 'knowledge'
      ? { scope: 'asset', assetId, path: segments.join('/') }
      : { scope: 'session', path: resource.relativePath };
    let size = 0, status: CitationMigrationPlan['files'][number]['status'];
    try {
      const location = locateCitationFile(session, reference);
      size = location.stat.size;
      status = hashCitationFile(location.resolved) === resource.sha256 ? 'verified' : 'content-changed';
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      status = 'missing';
    }
    // V2 did not store size. A missing original uses 0; the original digest is
    // always retained, so current/missing bytes cannot pass version validation.
    files.push({ resourceId: resource.resourceId, path: resource.relativePath, status, sizeBasis: status === 'verified' ? 'verified-original' : status === 'missing' ? 'unknown-zero-placeholder' : 'current-file-only' });
    const sourceKey = `${reference.scope}:${reference.assetId || old.sessionId}:${reference.path}`;
    const sourceVersionId = `sv_${hash(JSON.stringify([sourceKey, resource.sha256]))}`;
    sourceIds.set(resource.resourceId, sourceVersionId);
    const metadata: CitationMetadata = Object.fromEntries((['author', 'issuer', 'issuedAt', 'standardNumber', 'edition', 'url'] as const).flatMap((key) => work[key] === undefined ? [] : [[key, work[key]]]));
    if (!metadata.url && resource.sourceUrl) metadata.url = resource.sourceUrl;
    if (!sources.some((item) => item.sourceVersionId === sourceVersionId)) sources.push({ sourceVersionId, sourceKey, title: work.title, acquiredAt: resource.acquiredAt || old.generatedAt, content: { kind: 'file', ...reference, mimeType: resource.mimeType, sha256: resource.sha256, size }, ...(Object.keys(metadata).length ? { metadata } : {}) });
  }
  const locators = new Map(old.locators.map((item) => [item.locatorId, item]));
  const referenced = new Set(old.occurrences.map((item) => item.locatorId));
  const occurrences = [...old.occurrences, ...old.locators.filter((item) => !referenced.has(item.locatorId)).map((item) => ({ occurrenceId: item.locatorId, locatorId: item.locatorId }))];
  for (const occurrence of occurrences) {
    const oldLocator = locators.get(occurrence.locatorId);
    const sourceVersionId = oldLocator && sourceIds.get(oldLocator.resourceId);
    if (!sourceVersionId) throw new Error(`Dangling occurrence: ${occurrence.occurrenceId}`);
    const fields = Object.fromEntries((['page', 'printedPage', 'section', 'nodeId', 'lineStart', 'lineEnd'] as const).flatMap((key) => oldLocator[key] === undefined ? [] : [[key, oldLocator[key]]]));
    const section = [oldLocator.section, oldLocator.clause, oldLocator.table, oldLocator.figure, oldLocator.sourceUnit].filter(Boolean).join(' · ');
    if (section) fields.section = section;
    const locator = parseCitationLocator(Object.keys(fields).length ? { kind: 'document', ...fields } : { kind: 'source' });
    if (!locator) throw new Error(`Invalid legacy locator: ${oldLocator.locatorId}`);
    evidence.push({ evidenceId: occurrence.occurrenceId, sourceVersionId, locator, contentKind: oldLocator.quote ? 'summary' : 'source-only', ...(oldLocator.quote ? { text: oldLocator.quote } : {}) });
  }
  const parsed = parseCitationRegistryStructured({ protocol: 'pi-citation', version: '3.0', schemaVersion: 2, sessionId: old.sessionId, sources, evidence });
  if (!parsed.ok) throw new Error(`${file}: ${parsed.diagnostics[0].message}`);
  if (Buffer.byteLength(JSON.stringify(parsed.value)) > CITATION_REGISTRY_LIMIT) throw new Error(`Migrated registry exceeds limit: ${file}`);
  return { cwd, file, original, registry: parsed.value, files };
}
