import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  CompleteEvidenceAnalysisSchema,
  EVIDENCE_ANALYSIS_ENTRY,
  WorkspaceTableSchema,
} from '../../../../../src/contracts/evidence-analysis.mts';
import { postHostOperation } from '../../../../shared/host-client.ts';
import {
  captureExperience,
  selectExperience,
  type ExperienceLookup,
  type ExperienceSelection,
} from './experience.ts';

const TABLE = 'analyze_workspace_table';
const COMPLETE = 'complete_evidence_analysis';
const REPAIR_TOOLS = new Set(['read', 'find', 'ls', 'grep', 'tau_resolve_citation', TABLE, COMPLETE]);
const MAX_REPAIR_CALLS = 6;
const MAX_REPAIR_MS = 180_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

type Source = { path: string; sha256: string; bytes: number };
type Proof = {
  id: string;
  toolCallId: string;
  sources: Source[];
  tableRunId?: string;
};
type TableResult = {
  runId: string;
  provenance: { files: Source[] };
  columns: string[];
  sourceColumns: string[];
  matchedRows: number;
  rows: unknown[];
  truncated: boolean;
};
type Approval = {
  status: 'answered' | 'missing';
  answer: string;
  evidence: string[];
  experience?: ExperienceSelection;
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
  chinese: boolean;
  userSeen: boolean;
  proofs: Map<string, Proof>;
  pendingReads: Map<string, Source>;
  experienceLookups: ExperienceLookup[];
  attempts: number;
  eligibleFailure: boolean;
  failedSources: Set<string>;
  approval?: Approval;
  repair: 'unused' | 'queued' | 'running';
  repairCalls: number;
  timer?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
  terminal?: 'verified' | 'missing' | 'incomplete';
};

const guide =
  'Finish the original data task now. Use read on the specific workspace source or analyze_workspace_table for CSV calculations. Report the observed coverage, such as the number and range of matched hours. Unrecorded time is not zero. Successful reads and queries return evidence IDs. Call complete_evidence_analysis with the actual answer and its IDs; omit status for a normal answer. If evidence is missing, try the relevant source first, then submit status missing and name the gap. A search hit or plan is not current evidence. If experience does not apply, continue the original task. Keep the answer concise.';
const repairNotice =
  'One read-only repair pass. Complete the last user request, with no plan-only reply. Immediately inspect the relevant workspace file using read or analyze_workspace_table, then call complete_evidence_analysis with the exact answer and returned IDs. If the records are unavailable, say which specific source or field is missing.';

function begin(text: string, userSeen = false): Run {
  return {
    id: randomUUID(),
    chinese: /\p{Script=Han}/u.test(text),
    userSeen,
    proofs: new Map(),
    pendingReads: new Map(),
    experienceLookups: [],
    attempts: 0,
    eligibleFailure: false,
    failedSources: new Set(),
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

function completionError(run: Run, status: Approval['status'] | undefined, answer: string, ids: string[]) {
  if (!status) return "Omit status for a normal answer, or send 'missing' for a checked source gap.";
  if (!answer.trim()) return 'Provide the actual answer or specific missing evidence.';
  if (ids.some((id) => !run.proofs.has(id))) return 'Use only evidence IDs returned in this task.';
  if (status === 'answered' && !ids.length) return 'Read the actual evidence before submitting an answer.';
  if (status === 'missing' && !run.proofs.size && !run.eligibleFailure)
    return 'Try reading the relevant source before declaring it missing.';
  if (status === 'missing' && run.proofs.size && !ids.length)
    return 'Include the evidence IDs used to determine what is missing.';
  return '';
}

function checkedPath(cwd: string, candidate: unknown) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return;
  try {
    const root = realpathSync(cwd);
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      return;
    const readable = relative.split(path.sep).join('/');
    if (readable.split('/').some((part) => part.startsWith('.') || part.includes(':'))) return;
    return { absolute, readable };
  } catch {
    return undefined;
  }
}

function readIdentity(file: { absolute: string; readable: string }): Source | undefined {
  try {
    if (path.relative(file.absolute, realpathSync(file.absolute)) !== '') return;
    const stat = statSync(file.absolute);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return;
    const bytes = readFileSync(file.absolute);
    if (bytes.length !== stat.size) return;
    return {
      path: file.readable,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return undefined;
  }
}

function record(run: Run, toolCallId: string, sources: Source[], tableRunId?: string) {
  const id = 'ev_' + createHash('sha256').update(run.id).update(toolCallId).digest('hex').slice(0, 16);
  const proof = {
    id,
    toolCallId,
    sources,
    ...(tableRunId ? { tableRunId } : {}),
  };
  run.proofs.set(id, proof);
  return proof;
}

function note(run: Run, terminal: 'missing' | 'incomplete' | 'checking') {
  if (run.chinese) {
    if (terminal === 'checking') return '正在补查本轮证据。';
    if (terminal === 'missing') return '资料不足。';
    if (run.proofs.size) return '已经取得部分工作区证据，本轮未提交可复核的最终答案。';
    if (run.failedSources.size)
      return '本轮未能核对这些来源：' + [...run.failedSources].slice(0, 3).join('、') + '。';
    return '本轮未取得可核对的工作区证据，分析尚未完成。';
  }
  if (terminal === 'checking') return 'Checking task evidence.';
  if (terminal === 'missing') return 'Evidence is incomplete.';
  if (run.proofs.size) return 'Some evidence was retrieved, but a verifiable final answer was not submitted.';
  if (run.failedSources.size)
    return 'Could not verify these sources: ' + [...run.failedSources].slice(0, 3).join(', ') + '.';
  return 'No workspace evidence was verified. The analysis is incomplete.';
}

export default function evidenceAnalysis(pi: ExtensionAPI) {
  const required = process.env.TAU_EVIDENCE_ANALYSIS_REQUIRED === '1';
  let active: Run | undefined;
  const failedTools = new Set<string>();
  const clearTimer = (run?: Run) => {
    if (run?.timer) clearTimeout(run.timer);
  };

  pi.on('before_agent_start', (event) => {
    if (!required) return;
    clearTimer(active);
    active = begin(event.prompt);
    return { systemPrompt: event.systemPrompt + '\n\n' + guide };
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
      if (!REPAIR_TOOLS.has(event.toolName))
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
    if (run && event.toolName === 'search_experience' && run.experienceLookups.length < 8) {
      run.experienceLookups.push(captureExperience(event.toolCallId, event.details, event.isError));
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

  pi.registerTool({
    name: TABLE,
    label: '只读分析工作区表格',
    description:
      'Read a workspace UTF-8 CSV. Filter exact text values, select columns, group and compute exact sums/counts. URLs, paths outside the workspace and arbitrary SQL are not inputs. Use known CSV headers. Count without a column counts rows. Set numeric: true on min/max or orderBy for a numeric column such as hour or total. Returns an evidence ID.',
    parameters: WorkspaceTableSchema,
    async execute(toolCallId, input, signal, _update, ctx) {
      const run = active;
      const file = checkedPath(ctx.cwd, input.file);
      if (run) run.attempts += 1;
      try {
        if (!file) throw new Error('Use a CSV path within the current workspace.');
        const { result } = await postHostOperation<{ result: TableResult }>(
          {
            endpoint: process.env.TAU_EVIDENCE_ANALYSIS_ENDPOINT,
            sessionId: process.env.TAU_EVIDENCE_ANALYSIS_SESSION_ID,
            token: process.env.TAU_EVIDENCE_ANALYSIS_TOKEN,
          },
          '/api/internal/analysis/table',
          { ...input, file: file.readable },
          { toolCallId, contractVersion: '1.0.0', signal, timeoutMs: 20_000 }
        );
        const evidence =
          run && run === active ? record(run, toolCallId, result.provenance.files, result.runId) : undefined;
        const details = {
          kind: 'analysis-table',
          ...result,
          evidenceId: evidence?.id,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(details) }],
          details,
        };
      } catch (cause) {
        if (run && run === active) {
          if (file) {
            run.eligibleFailure = true;
            run.failedSources.add(file.readable);
          }
        }
        failedTools.add(toolCallId);
        const error = cause instanceof Error ? cause.message : 'Workspace table read failed.';
        return {
          content: [{ type: 'text', text: error }],
          details: { kind: 'analysis-table-error' },
        };
      }
    },
  });
  pi.registerTool({
    name: COMPLETE,
    label: '提交核实后的分析结果',
    description:
      'Submit the actual final answer, not a plan. For answered, include evidence IDs returned by successful reads or table queries in the current task. For missing, state the concrete evidence gap after inspecting or trying the relevant source.',
    parameters: CompleteEvidenceAnalysisSchema,
    async execute(toolCallId, input): Promise<CompletionToolResult> {
      const run = active;
      if (run) run.approval = undefined;
      const status = completionStatus(input.status);
      const rejection = run
        ? completionError(run, status, input.answer, input.evidence)
        : 'No active evidence-backed task.';
      if (!run || !status || rejection) {
        failedTools.add(toolCallId);
        return {
          content: [{ type: 'text', text: rejection }],
          details: { kind: 'analysis-completion', accepted: false },
        };
      }
      run.approval = {
        status,
        answer: input.answer.trim(),
        evidence: [...input.evidence],
        experience: selectExperience(run.experienceLookups, input),
      };
      return {
        content: [{ type: 'text', text: 'Completion recorded. Finish this turn.' }],
        details: {
          kind: 'analysis-completion',
          accepted: true,
          status,
          evidence: input.evidence,
        },
      };
    },
  });

  pi.on('message_end', (event, ctx) => {
    const run = active;
    const message = event.message;
    if (!run || message.role !== 'assistant' || (message.stopReason !== 'stop' && !run.timedOut)) return;
    const approval = run.approval;
    if (approval && !run.timedOut) {
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
      const result = {
        ...message,
        content: [
          {
            type: 'text' as const,
            text: prefix + approval.answer + sourceLine,
          },
        ],
        evidenceCompletion: run.terminal,
      };
      return { message: result };
    }
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
      evidenceCompletion: 'incomplete' as const,
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
  pi.on('agent_settled', () => {
    const run = active;
    clearTimer(run);
    active = undefined;
    if (!run) return;
    pi.appendEntry(EVIDENCE_ANALYSIS_ENTRY, {
      analysisId: run.id,
      status: run.terminal ?? 'unconfirmed',
      attempts: run.attempts,
      repair: run.repair !== 'unused',
      evidence: [...run.proofs.values()],
      selected: run.terminal ? (run.approval?.evidence ?? []) : [],
      ...(run.experienceLookups.length
        ? {
            experience: {
              lookups: run.experienceLookups,
              selection: run.terminal ? (run.approval?.experience ?? null) : null,
            },
          }
        : {}),
    });
  });
}
