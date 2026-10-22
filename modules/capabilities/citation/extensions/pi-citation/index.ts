import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const Positive = Type.Integer({ minimum: 1 });
const Text = Type.String({ minLength: 1, maxLength: 4000 });
const Locator = Type.Union([
  Type.Object({ kind: Type.Literal('source') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('document'), page: Type.Optional(Positive), printedPage: Type.Optional(Text), section: Type.Optional(Text), nodeId: Type.Optional(Text), lineStart: Type.Optional(Positive), lineEnd: Type.Optional(Positive) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('table'), rowStart: Type.Optional(Positive), rowEnd: Type.Optional(Positive), columns: Type.Optional(Type.Array(Text)), sheet: Type.Optional(Text), cell: Type.Optional(Text) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('result'), field: Text }, { additionalProperties: false }),
]);
const Source = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: 'Concrete original/result file relative to this session, or to the selected asset when assetId is supplied. Never a URL, directory or catalog candidate; register URLs with webUrls in a separate call.' }),
  assetId: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  locator: Locator, contentKind: Type.Union([Type.Literal('excerpt'), Type.Literal('summary'), Type.Literal('result'), Type.Literal('source-only')]),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
  metadata: Type.Optional(Type.Object({ bibliographicType: Type.Optional(Type.Union([Type.Literal('S'), Type.Literal('R'), Type.Literal('M'), Type.Literal('J'), Type.Literal('EB/OL'), Type.Literal('DS'), Type.Literal('Z')])), author: Type.Optional(Type.Array(Text)), issuer: Type.Optional(Text), issuedAt: Type.Optional(Text), standardNumber: Type.Optional(Text), edition: Type.Optional(Text), url: Type.Optional(Text), version: Type.Optional(Text), timeRange: Type.Optional(Text), querySummary: Type.Optional(Text) }, { additionalProperties: false })),
  deliverable: Type.Optional(Type.Boolean({ description: 'True only for an intended final deliverable; delivery does not change source identity.' })),
}, { additionalProperties: false });
export default function citationExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => ({ systemPrompt: `${event.systemPrompt}\n\nCitations use a single registration step: tau_resolve_citation returns evidence IDs. Put [[cite:evidenceId]] after the supported claim; use [[cite:id1,id2]] for multiple original sources. Reuse IDs directly; there is no tau_cite step. Knowledge/data modules own discovery: start with selected asset overview, browse bounded directories, retrieve a few candidates, then read specific originals/results. Never load all asset bodies at startup or cite a catalog hit as evidence. Knowledge summaries must cite every supporting original location with contentKind summary; only checkable verbatim text is an excerpt. Existing result files can be cited directly without exporting special evidence JSON. Metadata/querySummary is descriptive, not proof of execution. Inline results are registered only by Host producers. Paths are relative to the active session or selected asset. Set deliverable only for requested final files, never intermediate scripts or inputs. Report bodies use the same markers; do not handwrite reference lists or expose local paths as citations.` }));
  pi.registerTool({
    name: 'tau_resolve_citation', label: '登记引用依据', description: 'Pin concrete authorized originals/results and register typed evidence. Provide exactly one of sources (local files) or webUrls (public HTTPS pages); omit the other field entirely. For mixed references, make separate calls and reuse evidence IDs from both. Returns only this registration, never the accumulated registry.',
    parameters: Type.Object({ sources: Type.Optional(Type.Array(Source, { minItems: 1, maxItems: 20, description: 'Local files only. Omit webUrls when supplying sources.' })), webUrls: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 10, description: 'Public HTTPS page URLs. Omit sources when supplying webUrls.' })) }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const endpoint = process.env.TAU_CITATION_ENDPOINT, sessionId = process.env.TAU_CITATION_SESSION_ID, token = process.env.TAU_CITATION_TOKEN;
      if (!endpoint || !sessionId || !token) throw new Error('Citation Host bridge is unavailable.');
      const response = await fetch(`${endpoint}/api/internal/citations/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, sessionId, token }) });
      const payload = await response.json() as { error?: string; citations?: { sources: { sourceVersionId: string; title: string }[]; evidence: { evidenceId: string; sourceVersionId: string; text?: string }[] }; deliverableEvidenceIds?: string[] };
      if (!response.ok || !payload.citations) throw new Error(payload.error || 'Citation registration failed.');
      return { content: [{ type: 'text' as const, text: payload.citations.evidence.map((item) => `[[cite:${item.evidenceId}]] · sourceVersionId=${item.sourceVersionId} · ${payload.citations?.sources.find((source) => source.sourceVersionId === item.sourceVersionId)?.title || '来源'}${item.text ? ` ${item.text.slice(0, 240)}` : ''}`).join('\n') }], details: { kind: 'tau-citations', citations: payload.citations, deliverableEvidenceIds: payload.deliverableEvidenceIds || [] } };
    },
  });
}
