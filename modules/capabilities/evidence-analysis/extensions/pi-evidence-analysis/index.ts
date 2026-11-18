import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { asRecord } from '../../../../../src/contracts/common.ts';
import type { SessionProfileV1 } from '../../../../../src/contracts/session-profile.ts';
import type { DeliveryStatus } from '../../../../../src/contracts/task-delivery.ts';
import {
  CompleteEvidenceAnalysisSchema,
  EVIDENCE_ANALYSIS_ENTRY,
  WorkspaceTableSchema,
} from '../../../../../src/contracts/evidence-analysis.mts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';
import {
  checkedPath, readIdentity, calculatedResult, observeTable, checkClaims, claimsText, calculationText,
  checkHandoffDelivery, note,
  type Source, type UnmatchedFilter, type Calculation, type TableObservation, type CheckedClaim, type Proof, type TableResult,
} from './evidence-data.ts';
import { HANDOFF, handoffGuide, registerHandoffTool } from './handoff-tool.ts';

const TABLE = 'analyze_workspace_table';
const COMPLETE = 'complete_evidence_analysis';
const REPAIR_TOOLS = new Set(['read', 'find', 'ls', 'grep', 'tau_resolve_citation', TABLE, HANDOFF, COMPLETE]);
const MAX_REPAIR_CALLS = 6;
const MAX_REPAIR_MS = 180_000;

type Approval = {
  status: 'answered' | 'missing';
  answer: string;
  evidence: string[];
  relatedToolCallIds: string[];
  claims?: CheckedClaim[];
};
type CompletionToolResult = {
  content: { type: 'text'; text: string }[];
  details: {
    kind: string;
    accepted: boolean;
    status?: Approval['status'];
    evidence?: string[];
  };
};
type Run = {
  id: string;
  question: string;
  chinese: boolean;
  userSeen: boolean;
  proofs: Map<string, Proof>;
  pendingReads: Map<string, Source>;
  relatedReceipts: Set<string>;
  deliveryReceipts: Map<string, string>;
  attempts: number;
  eligibleFailure: boolean;
  failedSources: Set<string>;
  aggregateAttempted: boolean;
  approval?: Approval;
  repair: 'unused' | 'queued' | 'running';
  repairCalls: number;
  timer?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
  terminal?: 'verified' | 'missing' | 'incomplete';
  providerStopAfterApproval?: 'error' | 'length';
};

const guide =
  'Establish the requested scope, population, measure and time basis before querying. A supplied CSV identifies the source, not the intended method. Map each explicitly named entity or category to the source column and exact value. Apply all of them together to the main comparison or aggregate. Grouping by an entity or seeing only that entity in the highest-ranked row does not restrict the population. Recheck unmatchedFilters without broadening scope. For numeric min/max use numeric:true. A single exact aggregate may use deliver:true when it answers the whole request. Otherwise submit table claims with complete_evidence_analysis. Use status missing only for a checked source gap.';
const claimGuide =
  'Table claims: give scope.expectedFilters from the requested entity and category, using exact source keys. Cite the same main evidenceId with scope and sample (matchedRows is the comparison population, even with limit:1). Re-query if the executed filters are missing any intended condition. If the question asks what supports a result for one item, separately count that subgroup and cite its count. Use value with column and optional zero-based row for measured values or names. If asked about time or freshness, add a time claim for each relevant time field using groupBy:[field], one COUNT(*) aggregate and the relevant filters. Use raw reported times. Put facts only in claims, with short labels and brief qualitative limitations.';
const repairNotice =
  'One read-only repair pass. Keep the requested scope. Check exact source filters and repair invalid evidence before submitting. ' + claimGuide;

function begin(text: string, userSeen = false): Run {
  return {
    id: randomUUID(),
    question: text,
    chinese: /\p{Script=Han}/u.test(text),
    userSeen,
    proofs: new Map(),
    pendingReads: new Map(),
    relatedReceipts: new Set(),
    deliveryReceipts: new Map(),
    attempts: 0,
    eligibleFailure: false,
    failedSources: new Set(),
    aggregateAttempted: false,
    repair: 'unused',
    repairCalls: 0,
  };
}

function completionStatus(value?: string): Approval['status'] | undefined {
  const status = value?.trim().toLowerCase();
  if (!status || ['answered', 'answer', 'completed', 'complete', 'verified', 'success'].includes(status))
    return 'answered';
  if (['missing', 'insufficient', 'insufficient_evidence'].includes(status)) return 'missing';
}

function completionError(run: Run, status: Approval['status'] | undefined, answer: string, ids: string[], related: string[]) {
  if (!status) return "Omit status for a normal answer, or send 'missing' for a checked source gap.";
  if (!answer.trim()) return 'Provide the actual answer or specific missing evidence.';
  if (ids.some((id) => !run.proofs.has(id))) return 'Use only evidence IDs returned in this task.';
  if (related.some((id) => !run.relatedReceipts.has(id))) return 'Use only related receipt IDs issued by successful tools in this task.';
  if (status === 'answered' && !ids.length) return 'Read the actual evidence before submitting an answer.';
  if (status === 'answered') {
    const selected = ids.flatMap((id) => run.proofs.get(id) ?? []).filter((proof) => !proof.unmatchedFilters?.length);
    if (!selected.length)
      return 'Check the unmatched filters against their source values and retry before answering.';
    if (run.aggregateAttempted && !selected.some((proof) => proof.aggregate))
      return 'The table calculation has no completed evidence in this answer. Correct the aggregate request and submit its evidence ID.';
    if (selected.every((proof) => !proof.tableRunId && proof.sources.every((file) => /\.csv$/i.test(file.path))))
      return 'Query the CSV with analyze_workspace_table and cite its returned evidence ID. The file read only identifies the source.';
  }
  if (status === 'missing' && !run.proofs.size && !run.eligibleFailure)
    return 'Try reading the relevant source before declaring it missing.';
  if (status === 'missing' && run.proofs.size && !ids.length)
    return 'Include the evidence IDs used to determine what is missing.';
  return '';
}

function record(run: Run, toolCallId: string, sources: Source[], tableRunId?: string, aggregate = false,
  calculation?: Calculation, unmatchedFilters?: UnmatchedFilter[], observation?: TableObservation) {
  const id = 'ev_' + createHash('sha256').update(run.id).update(toolCallId).digest('hex').slice(0, 16);
  const proof = {
    id,
    toolCallId,
    sources,
    ...(tableRunId ? { tableRunId } : {}),
    ...(aggregate ? { aggregate: true as const } : {}),
    ...(calculation ? { calculation } : {}),
    ...(observation ? { observation } : {}),
    ...(observation?.handoff ? { handoff: observation.handoff } : {}),
    ...(unmatchedFilters?.length ? { unmatchedFilters } : {}),
  };
  run.proofs.set(id, proof);
  return proof;
}

export default function evidenceAnalysis(pi: ExtensionAPI) {
  const task = JSON.parse(process.env.TRANSPORTX_SESSION_TASK_JSON || 'null') as SessionProfileV1['task'] | null;
  const required = task?.kind === 'data-query' && task.expectedOutputs?.includes('answer');
  const answerRequirements = task?.answerRequirements ?? [];
  let active: Run | undefined;
  const failedTools = new Set<string>();
  const clearTimer = (run?: Run) => {
    if (run?.timer) clearTimeout(run.timer);
  };

  pi.on('before_agent_start', (event) => {
    if (!required) return;
    clearTimer(active);
    active = begin(event.prompt);
    return { systemPrompt: event.systemPrompt + '\n\n' + handoffGuide + '\n' + guide + '\n' + claimGuide + (answerRequirements.length ? '\nThe complete answer must address these requirements: ' + JSON.stringify(answerRequirements) + '. Direct aggregate delivery is disabled; submit the full answer with complete_evidence_analysis.' : '') };
  });
  pi.on('message_start', (event) => {
    if (!required || event.message.role !== 'user') return;
    if (active && !active.userSeen) {
      active.userSeen = true;
      return;
    }
    clearTimer(active);
    const content = event.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');
    active = begin(text, true);
  });
  pi.on('session_shutdown', () => {
    clearTimer(active);
    active = undefined;
    failedTools.clear();
  });
  pi.on('tool_call', (event, ctx) => {
    const run = active;
    if (!run) return;
    if (event.toolName !== COMPLETE) run.approval = undefined;
    if (run.repair === 'running') {
      if (++run.repairCalls > MAX_REPAIR_CALLS) {
        run.timedOut = true;
        ctx.abort();
        return {
          block: true,
          reason: 'The evidence repair budget is exhausted.',
        };
      }
      if (!REPAIR_TOOLS.has(event.toolName) || (event.toolName === HANDOFF && !['inspect','prepare'].includes(String(event.input.action))))
        return {
          block: true,
          reason: 'This repair pass only permits read-only workspace evidence operations and completion.',
        };
    }
    if (event.toolName === 'read') {
      const file = checkedPath(ctx.cwd, event.input.path);
      const identity = file && readIdentity(file);
      if (identity) run.pendingReads.set(event.toolCallId, identity);
    }
  });
  pi.on('tool_result', (event, ctx) => {
    if (failedTools.delete(event.toolCallId)) return { isError: true };
    const run = active;
    const details = asRecord(event.details);
    if (run && !event.isError && details?.accepted === true && typeof details.receiptId === 'string' && details.receiptId.length > 0 && details.receiptId.length <= 200 && run.relatedReceipts.size < 64) {
      run.relatedReceipts.add(details.receiptId as string);
      if (typeof details.deliveryReference === 'string' && details.deliveryReference.length > 0 && details.deliveryReference.length <= 200)
        run.deliveryReceipts.set(details.deliveryReference, details.receiptId);
    }
    if (!run || event.toolName !== 'read') return;
    const before = run.pendingReads.get(event.toolCallId);
    run.pendingReads.delete(event.toolCallId);
    const file = checkedPath(ctx.cwd, event.input.path);
    if (!file) return;
    run.attempts += 1;
    if (event.isError) {
      run.eligibleFailure = true;
      run.failedSources.add(file.readable);
      return;
    }
    const identity = readIdentity(file);
    if (
      !before ||
      !identity ||
      before.sha256 !== identity.sha256 ||
      before.path !== identity.path ||
      !event.content.length
    )
      return;
    const proof = record(run, event.toolCallId, [identity]);
    return {
      content: [...event.content, { type: 'text', text: `Evidence ID: ${proof.id} (${identity.path})` }],
    };
  });

  registerHandoffTool(pi, () => active, id => failedTools.add(id), (review, turnId) => {
    const run = active;
    if (!run || run.id !== turnId) return;
    const label = run.chinese ? (review.status === 'resolved' ? '复核已关闭' : '复核已登记') : (review.status === 'resolved' ? 'Review resolved' : 'Review recorded');
    run.approval = { status: 'answered', evidence: [], relatedToolCallIds: [],
      answer: label + ' · `' + review.id + '`' + (review.url ? '\n\n[' + (run.chinese ? '打开对应 Studio' : 'Open the linked Studio') + '](' + review.url + ')' : '') };
  });

  pi.registerTool({
    name: TABLE,
    label: '只读分析工作区表格',
    description:
      'Query a workspace CSV with exact source text filters. Verify and retry any unmatchedFilters. For calculations use aggregates (count, sum, avg, min, max) and omit select. Count rows by omitting column. Set numeric:true for numeric min/max. Set deliver:true when the calculation answers the whole task. For inspection omit aggregates and use select or limit.',
    parameters: WorkspaceTableSchema,
    async execute(toolCallId, input, signal, _update, ctx) {
      const run = active;
      const file = checkedPath(ctx.cwd, input.file);
      const { deliver, ...query } = input;
      const isAggregate = !!query.aggregates?.length;
      if (run) {
        run.attempts += 1;
        run.aggregateAttempted ||= isAggregate || deliver === true;
      }
      try {
        if (!file) throw new Error('Use a CSV path within the current workspace.');
        const { result } = await postHostOperation<{ result: TableResult }>(
          {
            endpoint: process.env.TAU_EVIDENCE_ANALYSIS_ENDPOINT,
            sessionId: process.env.TAU_EVIDENCE_ANALYSIS_SESSION_ID,
            token: process.env.TAU_EVIDENCE_ANALYSIS_TOKEN,
          },
          '/api/internal/analysis/table',
          { ...query, file: file.readable, ...(run ? { handoffTurn: run.id } : {}) },
          { toolCallId, contractVersion: '1.2.0', signal, timeoutMs: 20_000 }
        );
        const unmatched = result.unmatchedFilters;
        const usableAggregate = isAggregate && !unmatched?.length && !result.truncated && result.rows.length > 0;
        const calculation = usableAggregate ? calculatedResult(result, query.filters ?? []) : undefined;
        const evidence =
          run && run === active && !result.provenance.previewOnly
            ? record(run, toolCallId, result.provenance.files, result.runId,
              usableAggregate, calculation, unmatched, observeTable(result))
            : undefined;
        const delivered = !!(deliver && !result.provenance.handoff && !answerRequirements.length && evidence && calculation && run);
        if (delivered && run && evidence && calculation) {
          run.approval = {
            status: 'answered',
            answer: calculationText(calculation, run.chinese),
            evidence: [evidence.id],
            relatedToolCallIds: [...run.relatedReceipts].slice(-8),
          };
          clearTimer(run);
        }
        const details = {
          kind: 'analysis-table',
          ...result,
          evidenceId: evidence?.id,
          ...(deliver ? {
            delivered,
            deliveryNote: delivered
              ? 'Computed result submitted. Finish the turn without more tool calls.'
              : answerRequirements.length
                ? 'Direct delivery is disabled because this task requires explanation. Submit the complete answer with complete_evidence_analysis.'
                : result.provenance.handoff
                  ? 'A reviewed handoff requires structured evidence completion.'
                : unmatched?.length
                ? 'No source row contains one or more exact filter values. Verify the examples against the request and retry.'
                : 'A direct delivery needs an active evidence task and a complete, bounded aggregate result.',
          } : {}),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(details) }],
          details,
        };
      } catch (cause) {
        if (
          run && run === active && file &&
          cause instanceof HostCallError && cause.code === 'workspace_table_source_missing'
        ) {
          run.eligibleFailure = true;
          run.failedSources.add(file.readable);
        }
        failedTools.add(toolCallId);
        const error = cause instanceof Error ? cause.message : 'Workspace table read failed.';
        return {
          content: [{ type: 'text', text: error }],
          details: { kind: 'analysis-table-error', ...(cause instanceof HostCallError ? { code: cause.code } : {}) },
        };
      }
    },
  });
  pi.registerTool({
    name: COMPLETE,
    label: '提交核实后的分析结果',
    description:
      'Submit the final result. For a table answer use claims tied to actual query outputs; include scope and sample on the same evidence ID, measured values by column, and grouped time evidence when relevant. Otherwise provide the answer and evidence, or a checked missing-source gap.',
    parameters: CompleteEvidenceAnalysisSchema,
    async execute(toolCallId, input): Promise<CompletionToolResult> {
      const run = active;
      if (run) run.approval = undefined;
      const status = completionStatus(input.status);
      const explicit = input.relatedToolCallIds ?? [];
      const automatic = run ? [...run.deliveryReceipts.values()].reverse().filter(id => !explicit.includes(id)) : [];
      const related = [...explicit, ...automatic.slice(0, Math.max(0, 8 - explicit.length))];
      const ids = [...new Set([...(input.evidence ?? []), ...(input.claims ?? []).map(claim => claim.evidenceId)])];
      let answer = input.answer?.trim() ?? '';
      let claims: CheckedClaim[] | undefined;
      let rejection = 'No active evidence-backed task.';
      if (run) {
        try {
          if (ids.length > 16) throw new Error('Use at most 16 distinct evidence IDs.');
          if (status !== 'answered' && input.claims?.length)
            throw new Error('Submit table claims only with an answered result.');
          if (status === 'answered' && ids.some(id => run.proofs.has(id) && !!run.proofs.get(id)?.tableRunId)) {
            if (!input.claims?.length) {
              // Report the source error first, so a retry can obtain valid rows.
              const sourceError = completionError(run, status, answer || 'Table answer', ids, related);
              throw new Error(sourceError || 'A table answer requires structured claims. Cite the same query for scope and sample.');
            }
            claims = checkClaims(run.proofs, input.claims);
            const review = answer
              ? '\n\n' + (run.chinese ? '**分析说明，待人工复核**' : '**Interpretation for review**') + '\n\n' + answer
              : '';
            answer = (run.chinese ? '**逐项核对的结果**' : '**Evidence-bound results**') + '\n\n' + claimsText(claims, run.chinese) + review;
          } else if (input.claims?.length) throw new Error('Table claims require evidence from a table query in this turn.');
          if (status === 'answered') checkHandoffDelivery(run.proofs, ids, claims ?? []);
          rejection = completionError(run, status, answer, ids, related);
        } catch (error) {
          rejection = error instanceof Error ? error.message : 'The evidence claims could not be checked.';
        }
      }
      if (!run || !status || rejection) {
        failedTools.add(toolCallId);
        return {
          content: [{ type: 'text', text: rejection }],
          details: { kind: 'analysis-completion', accepted: false },
        };
      }
      run.approval = {
        status,
        answer,
        evidence: ids,
        relatedToolCallIds: [...related],
        claims,
      };
      clearTimer(run);
      return {
        content: [{ type: 'text', text: 'Completion recorded. Finish this turn.' }],
        details: {
          kind: 'analysis-completion',
          accepted: true,
          status,
          evidence: ids,
        },
      };
    },
  });

  pi.on('message_end', (event, ctx) => {
    const run = active;
    const message = event.message;
    if (!run || message.role !== 'assistant') return;
    const approval = run.approval;
    const stopReason = message.stopReason;
    const providerStopped = stopReason === 'error' || stopReason === 'length';
    if (approval && !run.timedOut && (stopReason === 'stop' || providerStopped)) {
      if (providerStopped) run.providerStopAfterApproval = stopReason;
      run.terminal = approval.status === 'answered' ? 'verified' : 'missing';
      const checked = [
        ...new Set(
          approval.evidence.flatMap((id) => run.proofs.get(id)?.sources.map((source) => source.path) ?? [])
        ),
      ];
      const sourceLine = checked.length
        ? '\n\n' +
          (run.chinese ? '本轮核对：' : 'Checked in this run: ') +
          checked.map((file) => `\`${file.replaceAll('\`', '')}\``).join(', ')
        : '';
      const prefix = run.terminal === 'missing' ? note(run, 'missing') + '\n\n' : '';
      const delivery: DeliveryStatus = run.terminal === 'verified' ? 'submitted' : 'needs_review';
      const result = {
        ...message,
        stopReason: 'stop' as const,
        errorMessage: undefined,
        content: [
          {
            type: 'text' as const,
            text: prefix + approval.answer + sourceLine,
          },
        ],
        delivery: { status: delivery },
      };
      return { message: result };
    }
    if (message.stopReason !== 'stop' && !run.timedOut) return;
    if (run.repair === 'unused' && !ctx.hasPendingMessages()) {
      run.repair = 'queued';
      return {
        message: {
          ...message,
          content: [{ type: 'text', text: note(run, 'checking') }],
        },
      };
    }
    run.terminal = 'incomplete';
    const result = {
      ...message,
      content: [{ type: 'text' as const, text: note(run, 'incomplete') }],
      delivery: { status: 'incomplete' as const },
    };
    return { message: result };
  });

  pi.on('agent_end', (_event, ctx: ExtensionContext) => {
    const run = active;
    if (!run || run.repair !== 'queued' || ctx.hasPendingMessages() || ctx.signal?.aborted) return;
    run.repair = 'running';
    run.timer = setTimeout(() => {
      if (active === run && !run.terminal) {
        run.timedOut = true;
        ctx.abort();
      }
    }, MAX_REPAIR_MS);
    run.timer.unref?.();
    pi.sendMessage(
      {
        customType: EVIDENCE_ANALYSIS_ENTRY,
        content: repairNotice,
        display: false,
      },
      { deliverAs: 'followUp', triggerTurn: true }
    );
  });
  pi.on('agent_settled', async () => {
    const run = active;
    clearTimer(run);
    active = undefined;
    if (!run) return;
    if (run.terminal === 'verified' && run.approval?.relatedToolCallIds.length) {
      try {
        const selectedTableToolCallIds = run.approval.evidence.flatMap(id => {
          const proof = run.proofs.get(id); return proof?.tableRunId ? [proof.toolCallId] : [];
        });
        const result = await postHostOperation<{ synced: number; pending: number }>(
          { endpoint: process.env.TAU_EVIDENCE_ANALYSIS_ENDPOINT, sessionId: process.env.TAU_EVIDENCE_ANALYSIS_SESSION_ID, token: process.env.TAU_EVIDENCE_ANALYSIS_TOKEN },
          '/api/internal/analysis/finalize', { runId: run.id, relatedToolCallIds: run.approval.relatedToolCallIds, selectedTableToolCallIds },
          { toolCallId: run.id, contractVersion: '1.0.0', timeoutMs: 45_000 }
        );
        if (result.pending) pi.sendMessage({ customType: 'transportx.receipt-sync', content: run.chinese ? '经验使用回执尚未同步，可稍后重试；本轮答案已保留。' : 'Experience use receipt is pending synchronization; the answer is retained.', display: true }, { triggerTurn: false });
      } catch {
        pi.sendMessage({ customType: 'transportx.receipt-sync', content: run.chinese ? '经验使用回执同步未确认；本轮答案已保留。' : 'Experience use receipt synchronization was not confirmed; the answer is retained.', display: true }, { triggerTurn: false });
      }
    }
    pi.appendEntry(EVIDENCE_ANALYSIS_ENTRY, {
      analysisId: run.id,
      status: run.terminal ?? 'unconfirmed',
      attempts: run.attempts,
      repair: run.repair !== 'unused',
      evidence: [...run.proofs.values()].map(({ observation: _observation, ...proof }) => proof),
      selected: run.terminal ? (run.approval?.evidence ?? []) : [],
      ...(run.terminal === 'verified' && run.approval?.claims ? { claims: run.approval.claims } : {}),
      ...(run.terminal && run.approval?.relatedToolCallIds.length
        ? { relatedToolCallIds: run.approval.relatedToolCallIds }
        : {}),
      ...(run.providerStopAfterApproval ? { providerStopAfterApproval: run.providerStopAfterApproval } : {}),
    });
  });
}
