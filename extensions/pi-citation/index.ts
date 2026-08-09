import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CITATION_ENVELOPE_PROTOCOL,
  CITATION_ENVELOPE_VERSION,
  parseCitationEnvelope,
  type CitationEnvelope,
  type CitationLocator,
  type CitationRecord,
  type CitationSource,
  type CitationSourceKind,
} from '../../src/contracts/index.ts';

const execFileAsync = promisify(execFile);
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, '..', '..');
const PYTHON = process.env.TAU_PYTHON_COMMAND || 'python3';
export function externalProcessPath(filePath: string) {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(marker)) return filePath;
  const unpacked = filePath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : filePath;
}
const SEARCH_SCRIPT = externalProcessPath(path.join(PROJECT_ROOT, 'modules', 'official', 'traffic-knowledge', 'skill', 'scripts', 'search_knowledge.py'));
const KNOWLEDGE_ID_RE = /^K-[A-Za-z0-9_.-]+-\d{6}$/;
const MARKER_RE = /\[\[cite:([^\]\r\n]+)\]\]/g;
const REFERENCE_START = '<!-- tau:references:start -->';
const REFERENCE_END = '<!-- tau:references:end -->';

const ArtifactSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  citationId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.:-]{1,180}$' })),
  quote: Type.Optional(Type.String({ maxLength: 4000 })),
  section: Type.Optional(Type.String({ maxLength: 500 })),
  page: Type.Optional(Type.Number({ minimum: 1 })),
}, { additionalProperties: false });

const TauCiteSchema = Type.Object({
  knowledgeIds: Type.Optional(Type.Array(Type.String({ pattern: '^K-[A-Za-z0-9_.-]+-\\d{6}$' }), { minItems: 1, maxItems: 80 })),
  artifacts: Type.Optional(Type.Array(ArtifactSchema, { minItems: 1, maxItems: 20 })),
}, { additionalProperties: false });

type KnowledgeResult = {
  knowledge_id: string;
  doc_id: string;
  title: string;
  statement: string;
  document_class: string;
  normative_force: string;
  verification_status: string;
  source: { kind: CitationSourceKind; mime_type: string; relative_path: string; sha256: string };
  source_refs: Array<{
    node_id?: string;
    pdf_page?: number;
    printed_page?: string;
    source_unit?: string;
    line_start?: number;
    line_end?: number;
  }>;
};

type ArtifactInput = {
  path: string;
  title?: string;
  citationId?: string;
  quote?: string;
  section?: string;
  page?: number;
};

function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function mimeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const values: Record<string, [CitationSourceKind, string]> = {
    '.pdf': ['pdf', 'application/pdf'],
    '.png': ['image', 'image/png'],
    '.jpg': ['image', 'image/jpeg'],
    '.jpeg': ['image', 'image/jpeg'],
    '.gif': ['image', 'image/gif'],
    '.webp': ['image', 'image/webp'],
    '.svg': ['image', 'image/svg+xml'],
    '.md': ['document', 'text/markdown'],
    '.txt': ['document', 'text/plain'],
    '.html': ['document', 'text/html'],
    '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.csv': ['document', 'text/csv'],
    '.tsv': ['document', 'text/tab-separated-values'],
    '.xlsx': ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.xls': ['document', 'application/vnd.ms-excel'],
  };
  const value = values[extension];
  if (!value) throw new Error(`Unsupported citation artifact type: ${extension || 'unknown'}`);
  return value;
}

async function readKnowledge(knowledgeId: string): Promise<KnowledgeResult> {
  if (!KNOWLEDGE_ID_RE.test(knowledgeId)) throw new Error(`Invalid knowledge ID: ${knowledgeId}`);
  const { stdout } = await execFileAsync(PYTHON, [SEARCH_SCRIPT, 'cite', knowledgeId, '--json'], { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout) as KnowledgeResult;
}

function knowledgeCitation(result: KnowledgeResult) {
  if (!result.source_refs.length) throw new Error(`Knowledge item has no source locator: ${result.knowledge_id}`);
  const sourceId = `knowledge:${result.doc_id}`;
  const ref = result.source_refs[0];
  const locatorId = `locator:${result.knowledge_id}`;
  const source: CitationSource = {
    sourceId,
    kind: result.source.kind,
    scope: 'knowledge',
    title: result.title,
    relativePath: result.source.relative_path,
    mimeType: result.source.mime_type,
    sha256: result.source.sha256,
  };
  const locator: CitationLocator = {
    locatorId,
    sourceId,
    quote: result.statement,
    ...(ref.node_id ? { nodeId: ref.node_id } : {}),
    ...(ref.pdf_page ? { page: ref.pdf_page } : {}),
    ...(ref.printed_page ? { printedPage: String(ref.printed_page) } : {}),
    ...(ref.source_unit ? { sourceUnit: ref.source_unit } : {}),
    ...(ref.line_start ? { lineStart: ref.line_start } : {}),
    ...(ref.line_end ? { lineEnd: ref.line_end } : {}),
  };
  const citation: CitationRecord = {
    citationId: result.knowledge_id,
    knowledgeId: result.knowledge_id,
    sourceId,
    locatorId,
    documentClass: result.document_class,
    normativeForce: result.normative_force,
    verificationStatus: result.verification_status,
  };
  return { source, locator, citation };
}

function artifactCitation(cwd: string, input: ArtifactInput) {
  const root = fs.realpathSync(cwd);
  const requested = path.resolve(cwd, input.path);
  const resolved = fs.realpathSync(requested);
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Citation artifact is outside the active task: ${input.path}`);
  const [kind, mimeType] = mimeFor(resolved);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  const sourceId = `artifact:${sha256.slice(0, 24)}`;
  const citationId = input.citationId || sourceId;
  const locatorId = `locator:${citationId}`;
  const source: CitationSource = {
    sourceId,
    kind,
    scope: 'session',
    title: input.title?.trim() || path.basename(resolved),
    relativePath: path.relative(root, resolved),
    mimeType,
    sha256,
  };
  const locator: CitationLocator = {
    locatorId,
    sourceId,
    ...(input.quote?.trim() ? { quote: input.quote.trim() } : {}),
    ...(input.section?.trim() ? { section: input.section.trim() } : {}),
    ...(input.page ? { page: input.page } : {}),
  };
  const citation: CitationRecord = { citationId, sourceId, locatorId, verificationStatus: 'session_artifact' };
  return { source, locator, citation };
}

function artifactPath(cwd: string, input: ArtifactInput) {
  const root = fs.realpathSync(cwd);
  const resolved = fs.realpathSync(path.resolve(cwd, input.path));
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Citation artifact is outside the active task: ${input.path}`);
  }
  return resolved;
}

function markdownCitationIds(markdown: string) {
  const ids: string[] = [];
  const seen = new Set<string>();
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(markdown))) {
    for (const rawId of match[1].split(',')) {
      const id = rawId.trim();
      if (!KNOWLEDGE_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function locatorText(locator: CitationLocator) {
  const parts: string[] = [];
  if (locator.page) parts.push(`PDF 第 ${locator.page} 页`);
  if (locator.printedPage && locator.printedPage !== String(locator.page ?? '')) {
    parts.push(`正文第 ${locator.printedPage} 页`);
  }
  if (locator.sourceUnit) parts.push(locator.sourceUnit);
  else if (locator.nodeId) parts.push(locator.nodeId);
  else if (locator.section) parts.push(locator.section);
  if (locator.lineStart) {
    parts.push(
      locator.lineEnd && locator.lineEnd !== locator.lineStart
        ? `第 ${locator.lineStart}–${locator.lineEnd} 行`
        : `第 ${locator.lineStart} 行`,
    );
  }
  return parts.join('，') || '原始资料';
}

function quoteExcerpt(quote?: string) {
  const normalized = quote?.replace(/\s+/g, ' ').trim() || '';
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
}

function detailedReferenceBlock(items: ReturnType<typeof knowledgeCitation>[]) {
  return [
    REFERENCE_START,
    '## 引用依据（逐条出处）',
    '',
    ...items.map(({ source, locator, citation }, index) => {
      const quote = quoteExcerpt(locator.quote);
      return `${index + 1}. **《${source.title}》** — ${locatorText(locator)}；引用标识 \`${citation.citationId}\`${quote ? `。原文摘录：“${quote}”` : ''}`;
    }),
    REFERENCE_END,
  ].join('\n');
}

function stripManualReferenceTail(markdown: string) {
  return markdown
    .replace(/\n+(?:---\s*\n+)?#{1,3}\s+(?:参考依据|参考文献|引用依据)\s*\n[\s\S]*$/u, '')
    .trimEnd();
}

function injectMarkdownReferences(
  cwd: string,
  artifact: ArtifactInput,
  citationsById: Map<string, ReturnType<typeof knowledgeCitation>>,
) {
  if (path.extname(artifact.path).toLowerCase() !== '.md') return;
  const resolved = artifactPath(cwd, artifact);
  const markdown = fs.readFileSync(resolved, 'utf8');
  const ids = markdownCitationIds(markdown);
  if (!ids.length) return;
  const citations = ids.map((id) => {
    const citation = citationsById.get(id);
    if (!citation) throw new Error(`Unable to resolve report citation: ${id}`);
    return citation;
  });
  const block = detailedReferenceBlock(citations);
  const generatedBlock = /<!-- tau:references:start -->[\s\S]*?<!-- tau:references:end -->/;
  const body = stripManualReferenceTail(markdown.replace(generatedBlock, ''));
  const updated = `${body}\n\n${block}\n`;
  fs.writeFileSync(resolved, updated, 'utf8');
}

export default function citationExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: `${event.systemPrompt}

When a final answer relies on knowledge-base evidence or a generated/used report, PDF, document, or image that the user should be able to inspect, call tau_cite first. Use only citation IDs returned by tau_cite, and place [[cite:<citationId>]] after the supported claim. Never put an absolute local path in the final answer.`,
  }));

  pi.registerTool({
    name: 'tau_cite',
    label: '注册引用',
    description: 'Register verified knowledge IDs or current-task report/PDF/document/image files as citations for the final answer.',
    promptGuidelines: [
      'Use knowledgeIds only after search-traffic-assurance-knowledge has verified the original source.',
      'Use artifacts for reports, PDFs, documents, and images inside the current task directory.',
      'Do not write a reference list into Markdown reports; keep [[cite:...]] markers in the body and tau_cite will generate the ordered reference list.',
      'After this tool succeeds, use the returned [[cite:...]] markers in the final answer.',
    ],
    parameters: TauCiteSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const knowledgeIds = [...new Set(params.knowledgeIds || [])];
      const artifacts = params.artifacts || [];
      if (!knowledgeIds.length && !artifacts.length) throw new Error('knowledgeIds or artifacts is required');
      const artifactKnowledgeIds = artifacts.flatMap((artifact) => {
        if (path.extname(artifact.path).toLowerCase() !== '.md') return [];
        return markdownCitationIds(fs.readFileSync(artifactPath(ctx.cwd, artifact), 'utf8'));
      });
      const allKnowledgeIds = [...new Set([...knowledgeIds, ...artifactKnowledgeIds])];
      const knowledgeCitations = (await Promise.all(allKnowledgeIds.map(readKnowledge))).map(knowledgeCitation);
      const citationsById = new Map(knowledgeCitations.map((item) => [item.citation.citationId, item]));
      for (const artifact of artifacts) injectMarkdownReferences(ctx.cwd, artifact, citationsById);
      const artifactCitations = artifacts.map((artifact) => artifactCitation(ctx.cwd, artifact));
      const registered = [...knowledgeCitations, ...artifactCitations];
      const sources = [...new Map(registered.map((item) => [item.source.sourceId, item.source])).values()];
      const envelope: CitationEnvelope = {
        protocol: CITATION_ENVELOPE_PROTOCOL,
        version: CITATION_ENVELOPE_VERSION,
        citationSetId: `citations:${crypto.randomUUID()}`,
        citations: registered.map((item) => item.citation),
        sources,
        locators: registered.map((item) => item.locator),
        generatedAt: new Date().toISOString(),
      };
      if (!parseCitationEnvelope(envelope)) throw new Error('Generated citation envelope failed validation');
      const requestedIds = new Set([
        ...knowledgeIds,
        ...artifactCitations.map((item) => item.citation.citationId),
      ]);
      const markers = envelope.citations
        .filter((item) => requestedIds.has(item.citationId))
        .map((item) => `[[cite:${item.citationId}]]`)
        .join(' ');
      return {
        content: [{ type: 'text' as const, text: `Registered ${envelope.citations.length} citation(s). Use: ${markers}` }],
        details: { kind: 'tau-citations' as const, citations: envelope },
      };
    },
  });
}
