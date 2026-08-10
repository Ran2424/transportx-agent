import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CITATION_ENVELOPE_PROTOCOL,
  CITATION_ENVELOPE_VERSION,
  parseCitationRegistryStructured,
  type CitationEnvelope,
  type CitationOccurrence,
  type CitationRegistry,
  type CitationResource,
} from '../contracts/index.js';

const REGISTRY_DIRECTORY = '.tau';
const REGISTRY_FILE = 'citations.json';

function registryPath(cwd: string) {
  return path.join(cwd, REGISTRY_DIRECTORY, REGISTRY_FILE);
}

function now() { return new Date().toISOString(); }

export function newCitationId(prefix: 'work' | 'resource' | 'locator' | 'occurrence' | 'provenance' | 'set') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function emptyCitationRegistry(sessionId: string): CitationRegistry {
  const timestamp = now();
  return {
    schemaVersion: 1,
    sessionId,
    protocol: CITATION_ENVELOPE_PROTOCOL,
    version: CITATION_ENVELOPE_VERSION,
    citationSetId: newCitationId('set'),
    generatedAt: timestamp,
    updatedAt: timestamp,
    works: [],
    resources: [],
    locators: [],
    occurrences: [],
    provenance: [],
  };
}

function sameEntity<T extends { [key: string]: unknown }>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeById<T extends { [key: string]: unknown }>(current: T[], incoming: T[], id: keyof T, label: string) {
  const byId = new Map(current.map((item) => [String(item[id]), item]));
  for (const item of incoming) {
    const itemId = String(item[id]);
    const previous = byId.get(itemId);
    if (previous && !sameEntity(previous, item)) throw new Error(`Citation ${label} ${itemId} conflicts with the existing registry.`);
    if (!previous) { current.push(item); byId.set(itemId, item); }
  }
}

export class CitationRegistryStore {
  readonly cwd: string;
  readonly sessionId: string;

  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    this.sessionId = sessionId;
  }

  get filePath() { return registryPath(this.cwd); }

  load() {
    if (!fs.existsSync(this.filePath)) return emptyCitationRegistry(this.sessionId);
    const parsed = parseCitationRegistryStructured(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    if (!parsed.ok) throw new Error(`Citation registry is invalid: ${parsed.diagnostics[0]?.message || 'unknown error'}`);
    return parsed.value;
  }

  save(registry: CitationRegistry) {
    const parsed = parseCitationRegistryStructured(registry);
    if (!parsed.ok) throw new Error(`Citation registry cannot be written: ${parsed.diagnostics[0]?.message || 'unknown error'}`);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `${REGISTRY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(parsed.value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return parsed.value;
  }

  register(envelope: CitationEnvelope) {
    const registry = this.load();
    if (envelope.protocol !== registry.protocol || envelope.version !== registry.version) throw new Error('Citation envelope version is not supported.');
    mergeById(registry.works, envelope.works, 'workId', 'work');
    mergeById(registry.resources, envelope.resources, 'resourceId', 'resource');
    mergeById(registry.locators, envelope.locators, 'locatorId', 'locator');
    mergeById(registry.occurrences, envelope.occurrences, 'occurrenceId', 'occurrence');
    mergeById(registry.provenance, envelope.provenance, 'provenanceId', 'provenance edge');
    registry.updatedAt = now();
    return this.save(registry);
  }

  resource(resourceId: string): CitationResource | null {
    return this.load().resources.find((item) => item.resourceId === resourceId) || null;
  }

  occurrence(occurrenceId: string): CitationOccurrence | null {
    return this.load().occurrences.find((item) => item.occurrenceId === occurrenceId) || null;
  }
}
