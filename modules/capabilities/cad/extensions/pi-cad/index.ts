import { readFileSync } from 'node:fs';
import type { TSchema } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { parseCadDrawResultStructured, parseCadInspectResultStructured, parseCadVerifyResultStructured } from '../../../../../src/contracts/index.ts';
import { postHostOperation } from '../../../../shared/host-client.ts';

type ToolResult = Record<string, unknown>;
const contracts = ['tool-contract', 'inspect-contract', 'verify-contract', 'execution-contract'].map((file) => {
  const contract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL(`../../${file}.json`, import.meta.url), 'utf8')));
  if (!contract) throw new Error('Invalid CAD Tool Contract');
  return contract;
});
const cadHost = () => ({ endpoint: process.env.TAU_CAD_ENDPOINT, sessionId: process.env.TAU_CAD_SESSION_ID, token: process.env.TAU_CAD_TOKEN });

function messages(result: ToolResult): string {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return [...diagnostics, ...warnings]
    .map((item) => item && typeof item === 'object' && 'message' in item ? String((item as { message: unknown }).message) : '')
    .filter(Boolean)
    .slice(0, 6)
    .join('；');
}

function drawText(result: ToolResult): string {
  if (result.ok === false) return `CAD 未完成：${messages(result) || '请查看诊断。'}`;
  if (result.dryRun === true) {
    const plan = result.plan as { operationCount?: number; matchedCount?: number; wouldCreate?: number; sampleHandles?: string[] } | undefined;
    return `CAD dry-run：操作 ${plan?.operationCount ?? 0}，命中 ${plan?.matchedCount ?? 0}，预计新增 ${plan?.wouldCreate ?? 0}。样例句柄：${(plan?.sampleHandles || []).slice(0, 10).join(', ') || '无'}。`;
  }
  const drawing = result.drawing as { path?: string; revision?: number; units?: string; entityCount?: number; layerCount?: number; sha256?: string } | undefined;
  const preview = result.preview as { png?: string; pdf?: string } | undefined;
  return `CAD 已提交：${drawing?.path || '未知路径'}，revision ${drawing?.revision ?? '?'}，单位 ${drawing?.units || '?'}，实体 ${drawing?.entityCount ?? '?'}，图层 ${drawing?.layerCount ?? '?'}。预览：${preview?.png || '无'}${preview?.pdf ? `；PDF：${preview.pdf}` : ''}。${messages(result) ? `注意：${messages(result)}` : ''}`;
}

export default function cadExtension(pi: ExtensionAPI) {
  const pending = new Map<string, { dispatched: boolean; mutation: boolean; result?: ReturnType<typeof failure> | { content: { type: 'text'; text: string }[]; details: ToolResult } }>();
  function failure(toolCallId: string, code: string, phase: string, message: string, unknown: boolean, mutation = true) {
    const error = { code, phase, message: message.slice(0, 1500), toolCallId, recovery: unknown
      ? 'Do not repeat cad_draw automatically. Query cad_execution with lookupToolCallId from this call. Preserve CAD files and job journals; cancellation does not confirm stopping.'
      : mutation ? 'No drawing was committed. Correct the reported issue before requesting a new execution.' : 'Correct the reported issue or repeat this read-only request.' };
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error) }], details: { kind: 'tau-cad-error', error } };
  }
  pi.on('session_shutdown', () => pending.clear());
  pi.on('tool_result', (event) => {
    if (!contracts.some((contract) => contract.piName === event.toolName)) return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (call?.result) return { ...call.result, isError: call.result.details.kind === 'tau-cad-error' };
    if (call?.dispatched && call.mutation && event.isError) return failure(event.toolCallId, 'cad_result_unknown', 'cancel_requested', 'CAD execution was not confirmed.', true);
  });
  for (const contract of contracts) {
    const action = contract.toolId.slice(4);
    pi.registerTool({
      name: contract.piName,
      label: `CAD ${action}`,
      description: action === 'draw'
        ? 'Create/import/edit a general-purpose revisioned 2D DXF. Python and other engines may generate DXF candidates: import the first draft, then commit-candidate with the same fileId/baseRevision/expectedSha256 and candidateMode=rebuild or based-on-current. Both modes require re-querying old entity references; a producer declaration does not guarantee handle identity. Successful commits automatically present/update the same Canvas view; do not re-import to show progress. from-geojson requires sourcePath, sourceCrs, target and layerMap. edit uses contextId to target an attached revision, or fileId/baseRevision/expectedSha256. A selection is reference information, not an edit boundary. After each commit, continue with the returned drawing.fileId, drawing.revision as baseRevision and drawing.sha256; do not reuse a stale contextId. exportPreview is opt-in. move/copy use drawing axes and units, not curve offsets. Bulk edits dryRun first. Lost responses must be queried with cad_execution, never automatically repeated.'
        : action === 'execution' ? 'Query or request cancellation of an existing CAD write. Supply exactly one operationId or lookupToolCallId. Never draws or retries. Unknown is not proof of no commit.'
        : action === 'inspect' ? 'Inspect DXF revision, full sha256, units, layers and requested entities with pagination. include=["geometry"] returns bounded precise geometry; geometryTruncated means query a narrower set. contextId defaults to selected entities when nonempty; an explicit selector overrides this focus. Use fileId for the whole current drawing. The result content contains the requested details.'
        : 'Reopen DXF for basic geometry checks; optionally exportPreview=true with previewOptions bounds/layers/width/height produces a whole or local PNG/PDF without a new revision. Passing does not establish visual conformity or design approval.',
      parameters: contract.input as unknown as TSchema,
      async execute(toolCallId, params, signal) {
        const call: { dispatched: boolean; mutation: boolean; result?: ReturnType<typeof failure> | { content: { type: 'text'; text: string }[]; details: ToolResult } } = { dispatched: false, mutation: action === 'draw' };
        pending.set(toolCallId, call);
        try {
          const payload = await postHostOperation<ToolResult>(cadHost(), `/api/internal/cad/${action}`, params as Record<string, unknown>, { toolCallId, contractVersion: contract.contractVersion, signal, timeoutMs: action === 'execution' ? 15_000 : 130_000, dispatched: () => { call.dispatched = true; } });
          const parser = action === 'draw' ? parseCadDrawResultStructured : action === 'inspect' ? parseCadInspectResultStructured : parseCadVerifyResultStructured;
          const parsed = action === 'execution' ? null : parser(payload.result);
          if (parsed && !parsed.ok) throw new Error('Invalid CAD result. Preserve existing files and verify the execution.');
          if (action === 'execution' && (typeof payload.operationId !== 'string' || !['running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(String(payload.state)))) throw new Error('Invalid CAD execution confirmation.');
          const result = (parsed?.ok ? parsed.value : payload) as ToolResult;
          if (action === 'draw' && result.ok === false) {
            call.result = failure(toolCallId, 'cad_draw_failed', 'validation', messages(result) || 'CAD validation failed.', false);
            return call.result;
          }
          const text = action === 'draw' ? `${drawText(result)}\n${JSON.stringify({ drawing: result.drawing, plan: result.plan, operationId: payload.operationId,
            presentation: result.canvas ? { viewId: (result.canvas as { viewId?: string }).viewId, status: 'accepted', browserRenderConfirmed: false } : undefined,
            references: (params as { kind?: string }).kind === 'commit-candidate' ? { requeryRequired: true, candidateMode: (params as { candidateMode?: string }).candidateMode } : undefined })}` : JSON.stringify(result);
          call.result = { content: [{ type: 'text', text }], details: { kind: contract.output.detailsKind, result, ...(action === 'execution' ? payload : {}), operationId: payload.operationId, ...(action === 'draw' && result.canvas ? { canvas: result.canvas } : {}) } };
        } catch (error) {
          const problem = error as Error & { code?: string; phase?: string; commit?: string };
          const unknown = action === 'draw' && call.dispatched && problem.commit !== 'not_started' && problem.commit !== 'not_committed';
          call.result = failure(toolCallId, unknown ? 'cad_result_unknown' : problem.code || 'cad_request_failed', problem.phase || 'host', problem.message, unknown, action === 'draw');
        }
        return call.result!;
      },
    });
  }
}
