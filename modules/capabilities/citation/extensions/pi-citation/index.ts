import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ArtifactSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: 'Path relative to the active session directory; absolute paths and knowledge-module paths are rejected.' }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  quote: Type.Optional(Type.String({ maxLength: 4000 })),
  section: Type.Optional(Type.String({ maxLength: 500 })),
  page: Type.Optional(Type.Number({ minimum: 1 })),
  lineStart: Type.Optional(Type.Number({ minimum: 1 })),
  lineEnd: Type.Optional(Type.Number({ minimum: 1 })),
  derivedFromResourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 180 }), { maxItems: 80 })),
}, { additionalProperties: false });
const DatasetSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: 'Path relative to the active session directory. Use this for generated CSV, JSONL, JSON, or spreadsheet results.' }), assetId: Type.String({ minLength: 1, maxLength: 180 }),
  version: Type.Optional(Type.String({ maxLength: 180 })), querySummary: Type.Optional(Type.String({ maxLength: 1000 })), timeRange: Type.Optional(Type.String({ maxLength: 300 })), title: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

const ResolveCitationSchema = Type.Object({
  knowledgeIds: Type.Optional(Type.Array(Type.String({ pattern: '^K-[A-Za-z0-9_.-]+-\\d{6}$' }), { minItems: 1, maxItems: 80 })),
  attachmentIds: Type.Optional(Type.Array(Type.String({ pattern: '^att_[a-z0-9]{12,32}$' }), { minItems: 1, maxItems: 80 })),
  artifacts: Type.Optional(Type.Array(ArtifactSchema, { minItems: 1, maxItems: 20 })),
  datasets: Type.Optional(Type.Array(DatasetSchema, { minItems: 1, maxItems: 20 })),
  webUrls: Type.Optional(Type.Array(Type.String({ format: 'uri', maxLength: 2000 }), { minItems: 1, maxItems: 10 })),
}, { additionalProperties: false });

const CiteSchema = Type.Object({
  locatorId: Type.String({ minLength: 1, maxLength: 180 }),
  role: Type.Optional(Type.Union([
    Type.Literal('support'), Type.Literal('background'), Type.Literal('data-source'), Type.Literal('method'), Type.Literal('counterexample'), Type.Literal('artifact-source'),
  ])),
  containerType: Type.Optional(Type.Union([Type.Literal('message'), Type.Literal('document'), Type.Literal('artifact')])),
  containerId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  anchorId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });

function citationHost() {
  const endpoint = process.env.TAU_CITATION_ENDPOINT;
  const sessionId = process.env.TAU_CITATION_SESSION_ID;
  const token = process.env.TAU_CITATION_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Citation Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

async function hostRequest(path: string, body: Record<string, unknown>) {
  const host = citationHost();
  const response = await fetch(`${host.endpoint}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
  });
  const payload = await response.json() as { error?: string; citations?: unknown; occurrence?: { occurrenceId?: string } };
  if (!response.ok || !payload.citations) throw new Error(payload.error || 'Citation Agent Host request failed.');
  return payload;
}

function locatorSummary(citations: any) {
  const resources = new Map<string, { relativePath?: string }>((citations.resources || []).map((item: any) => [item.resourceId, item]));
  return (citations.locators || []).map((item: any) => {
    const resource = resources.get(item.resourceId);
    const position = item.page ? `PDF 第${item.page}页` : item.clause || item.section || item.sourceUnit || item.nodeId || '原始资料';
    return `${item.locatorId}: ${resource?.relativePath || '来源'}，${position}`;
  }).join('\n');
}

export default function citationExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: `${event.systemPrompt}

When a final answer relies on knowledge, attachments, or task artifacts, call tau_resolve_citation first. Use knowledgeIds for knowledge cards so the Host can retain the original PDF or HTML source; do not cite copied knowledge JSONL or Markdown files as artifacts. Artifact and dataset paths must be relative to the active session directory, never absolute local paths. Select the precise locator that supports the claim, then call tau_cite and place its returned [[cite:occurrenceId]] marker after the claim. Never use local paths as citations or write reference lists into Markdown reports.`,
  }));

  pi.registerTool({
    name: 'tau_resolve_citation',
    label: '解析引用来源',
    description: 'Resolve verified knowledge, session attachments, task artifacts, or generated datasets into Host-controlled citation locator candidates. Use knowledgeIds for knowledge cards; artifact and dataset paths must be relative to the active session.',
    parameters: ResolveCitationSchema,
    async execute(_toolCallId, params) {
      if (!params.knowledgeIds?.length && !params.attachmentIds?.length && !params.artifacts?.length && !params.datasets?.length && !params.webUrls?.length) throw new Error('A citation source is required.');
      const result = await hostRequest('/api/internal/citations/resolve', params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: `Resolved citation locators:\n${locatorSummary(result.citations)}` }],
        details: { kind: 'tau-citations' as const, citations: result.citations },
      };
    },
  });

  pi.registerTool({
    name: 'tau_cite',
    label: '创建精确引用',
    description: 'Create one Host-registered citation occurrence from a previously resolved locator.',
    parameters: CiteSchema,
    async execute(toolCallId, params) {
      const result = await hostRequest('/api/internal/citations/cite', {
        ...params,
        containerType: params.containerType || 'message',
        containerId: params.containerId || `tool:${toolCallId}`,
      });
      const occurrenceId = result.occurrence?.occurrenceId;
      if (!occurrenceId) throw new Error('Citation Agent Host did not return an occurrence ID.');
      return {
        content: [{ type: 'text' as const, text: `Citation registered. Use: [[cite:${occurrenceId}]]` }],
        details: { kind: 'tau-citations' as const, citations: result.citations },
      };
    },
  });
}
