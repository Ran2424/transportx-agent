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

function inspectText(result: ToolResult): string {
  const summary = result.summary as { units?: string | null; entityCount?: number; layerCount?: number; extents?: unknown; sha256?: string } | undefined;
  const warning = messages(result);
  return `CAD 查询：单位 ${summary?.units ?? '未知'}，实体 ${summary?.entityCount ?? '?'}，图层 ${summary?.layerCount ?? '?'}。${summary?.sha256 ? `sha256 ${summary.sha256.slice(0, 12)}…。` : ''}${warning ? `警告：${warning}` : ''}`;
}

function verifyText(result: ToolResult): string {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const failed = checks.filter((item) => item && typeof item === 'object' && (item as { status?: string }).status === 'fail').length;
  const warned = checks.filter((item) => item && typeof item === 'object' && (item as { status?: string }).status === 'warning').length;
  const preview = result.preview as { png?: string; pdf?: string } | undefined;
  return `CAD 校验：${result.ok === true ? '通过' : '未通过'}；${checks.length} 项检查，${failed} 项失败，${warned} 项警告。${messages(result) ? `诊断：${messages(result)}` : ''}${preview ? ` 预览：${preview.png}；${preview.pdf}` : ''}`;
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
        ? 'Create/import/edit a revisioned 2D DXF. from-geojson requires sourcePath, sourceCrs, target and layerMap. edit uses contextId and operations for an attached selection; otherwise supply fileId, baseRevision and expectedSha256. exportPreview is opt-in. move/copy use drawing axes and units, not curve offsets. Bulk edits dryRun first. Lost responses must be queried with cad_execution, never automatically repeated.'
        : action === 'execution' ? 'Query or request cancellation of an existing CAD write. Supply exactly one operationId or lookupToolCallId. Never draws or retries. Unknown is not proof of no commit.'
        : action === 'inspect' ? 'Inspect DXF revision, exact sha256, units, layers, entities and coordinate metadata before editing.'
        : 'Reopen DXF for basic geometry checks; optionally exportPreview=true produces PNG/PDF without a new revision. Passing is not traffic engineering design approval.',
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
          const text = action === 'draw' ? drawText(result) : action === 'inspect' ? inspectText(result) : action === 'verify' ? verifyText(result) : JSON.stringify(result).slice(0, 6000);
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
