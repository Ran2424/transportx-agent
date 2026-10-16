import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CITATION_REGISTRY_LIMIT, parseCitationEnvelopeStructured, parseCitationRegistryStructured, publicCitationSource, type CitationEnvelope, type CitationRegistry } from '../contracts/index.js';

export function emptyCitationRegistry(sessionId: string): CitationRegistry {
  return { schemaVersion: 2, sessionId, protocol: 'pi-citation', version: '3.0', sources: [], evidence: [] };
}
function verifyInlineDigests(registry: CitationRegistry) {
  for (const source of registry.sources) {
    if (source.content.kind !== 'inline') continue;
    const value = source.content.value!;
    const canonical = typeof value === 'string' ? value : { columns: value.columns, rows: value.rows };
    if (crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') !== source.content.sha256) throw new Error('Inline citation content has changed since registration.');
  }
}
export class CitationRegistryStore {
  constructor(readonly cwd: string, readonly sessionId: string) {}
  get filePath() { return path.join(this.cwd, '.tau', 'citations.json'); }
  private checkDirectory() {
    const directory = path.dirname(this.filePath);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Citation registry directory cannot be a symlink.');
  }
  load(): CitationRegistry {
    this.checkDirectory();
    if (!fs.existsSync(this.filePath)) return emptyCitationRegistry(this.sessionId);
    const stat = fs.lstatSync(this.filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > CITATION_REGISTRY_LIMIT) throw new Error('Citation registry is unsafe or exceeds 8 MiB.');
    const parsed = parseCitationRegistryStructured(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    if (!parsed.ok) throw new Error(parsed.diagnostics[0].message);
    if (parsed.value.sessionId !== this.sessionId) throw new Error('Citation registry belongs to another session.');
    verifyInlineDigests(parsed.value);
    return parsed.value;
  }
  save(registry: CitationRegistry) {
    this.checkDirectory();
    const parsed = parseCitationRegistryStructured(registry);
    if (!parsed.ok || parsed.value.sessionId !== this.sessionId) throw new Error('Citation registry cannot be written: invalid records or session.');
    verifyInlineDigests(parsed.value);
    const serialized = JSON.stringify(parsed.value);
    if (Buffer.byteLength(serialized) > CITATION_REGISTRY_LIMIT) throw new Error('Citation registry exceeds 8 MiB.');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.filePath); }
    finally { fs.rmSync(temporary, { force: true }); }
    return parsed.value;
  }
  register(input: CitationEnvelope): CitationEnvelope {
    const parsed = parseCitationEnvelopeStructured(input);
    if (!parsed.ok) throw new Error(parsed.diagnostics[0].message);
    const delta = parsed.value;
    const registry = this.load();
    for (const source of delta.sources) {
      const existing = registry.sources.find((item) => item.sourceVersionId === source.sourceVersionId);
      if (existing && (existing.sourceKey !== source.sourceKey || JSON.stringify(existing.content) !== JSON.stringify(source.content))) throw new Error('SourceVersion ID conflicts with existing content.');
      if (!existing) registry.sources.push(source);
    }
    for (const evidence of delta.evidence) {
      const existing = registry.evidence.find((item) => item.evidenceId === evidence.evidenceId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(evidence)) throw new Error('Evidence ID conflicts with existing content.');
      if (!existing) registry.evidence.push(evidence);
    }
    this.save(registry);
    return { protocol: 'pi-citation', version: '3.0', sources: delta.sources.map((source) => publicCitationSource(registry.sources.find((item) => item.sourceVersionId === source.sourceVersionId)!)), evidence: delta.evidence };
  }
  list(offset = 0, limit = 200, ids?: string[]): CitationEnvelope {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid citation pagination.');
    const registry = this.load(), all = ids ? registry.evidence.filter((item) => ids.includes(item.evidenceId)) : registry.evidence;
    const evidence = all.slice(offset, offset + limit), sourceIds = new Set(evidence.map((item) => item.sourceVersionId));
    return { protocol: 'pi-citation', version: '3.0', sources: registry.sources.filter((item) => sourceIds.has(item.sourceVersionId)).map(publicCitationSource), evidence, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}) };
  }
  source(sourceVersionId: string) { return this.load().sources.find((item) => item.sourceVersionId === sourceVersionId) || null; }
}
