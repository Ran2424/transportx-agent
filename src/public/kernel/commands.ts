/**
 * Command ports (migration plan §4.2). Components never fetch(), touch the
 * WebSocket or assemble RPC JSON themselves — they call these ports.
 * Transport/HTTP failures are converted to serializable AppErrors here and
 * thrown; the kernel stores never see raw Error instances.
 */

import type { ModelRecord } from '../app-types.js';
import { appError } from '../../contracts/errors.ts';
import { parseCitationEnvelope, parseCitationDetail, type CitationDetail, type CitationEnvelope } from '../../contracts/citation.ts';
import type { GeoClientContextV1, GeoContextReferenceV1, GeoInteractionResponseV1 } from '../../contracts/geo-interaction.ts';
import type { CanvasContextV1, CanvasPresentationV1 } from '../../contracts/canvas.ts';
import type { SimulationRunSummary, SimulationIndex, SimulationBlock, SimulationEvent, SimulationNetworkView, SimulationQuery, SimulationExperiment } from '../../contracts/simulation.ts';
import { httpJson, httpText, rpcCommand, type CommandDeps } from './command-transport.js';
import { createPlatformCommands, type PlatformCommands } from './platform-commands.js';
import { createSessionCommands, type SessionCommands, type WorkspaceFileContent } from './session-commands.js';

export type SendPromptInput = { sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[]; canvasContextIds?: string[]; clientCommandId?: string };
export type SteerInput = { sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[]; canvasContextIds?: string[] };
export type FollowUpInput = { sessionId: string; message: string };
export type SetModelInput = { sessionId: string; model: string };
export type SetThinkingLevelInput = { sessionId: string; level: string };
export type ExtensionUiResponseInput = {
  sessionId: string | null;
  id?: string;
  response?: Record<string, unknown>;
};

export type AgentState = {
  model?: ModelRecord | null;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
  isCompacting?: boolean;
};

export type AgentCommands = {
  sendPrompt(input: SendPromptInput): Promise<void>;
  abort(sessionId: string): Promise<void>;
  steer(input: SteerInput): Promise<void>;
  followUp(input: FollowUpInput): Promise<void>;
  compact(sessionId: string): Promise<void>;
  setAutoCompaction(sessionId: string, enabled: boolean): Promise<void>;
  getState(sessionId: string): Promise<AgentState>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): Promise<void>;
};

export type ExtensionUiCommands = {
  respond(input: ExtensionUiResponseInput): Promise<void>;
};

export type CitationCommands = {
  list(sessionId: string, options?: { offset?: number; ids?: string[]; signal?: AbortSignal }): Promise<CitationEnvelope>;
  detail(sessionId: string, evidenceId: string, signal?: AbortSignal): Promise<CitationDetail>;
};

export type VideoCommands = {
  getMetrics(sessionId: string, resourceId: string): Promise<unknown>;
};

export type GeoCommands = {
  createContext(sessionId: string, context: GeoClientContextV1): Promise<GeoContextReferenceV1>;
  getContext(sessionId: string, contextId: string): Promise<GeoClientContextV1>;
  saveScreenshot(sessionId: string, input: { visualizationId: string; sceneRevision: number; dataUrl: string }): Promise<{ filename: string; path: string; bytes: number }>;
  respondScreenshot(sessionId: string, requestId: string, response: { status: 'captured'; dataUrl: string } | { status: 'failed'; reason: 'scene_revision_changed' | 'visualization_changed' | 'capture_failed' }): Promise<unknown>;
  respond(sessionId: string, requestId: string, response: { status: 'submitted'; context: GeoClientContextV1 } | { status: 'cancelled' } | { status: 'invalidated'; reason: 'scene_revision_changed' | 'visualization_changed' | 'resource_changed' }): Promise<{ response: GeoInteractionResponseV1; context?: GeoClientContextV1 }>;
};

export type CanvasCommands = {
  present(sessionId: string, input: { adapterId: string; resource: { scope: 'session-file'; path: string }; title?: string }): Promise<CanvasPresentationV1>;
  createContext(sessionId: string, input: { viewId: string; revision: number; target?: unknown; selection?: unknown }): Promise<CanvasContextV1>;
};

export type SimulationCommands = {
  experiment(sessionId: string, experimentId: string, signal?: AbortSignal): Promise<SimulationExperiment>;
  list(sessionId: string, signal?: AbortSignal): Promise<{ runs: Array<{ run: SimulationRunSummary; canvas: CanvasPresentationV1 }> }>;
  index(sessionId: string, runId: string, signal?: AbortSignal): Promise<{ run: SimulationRunSummary; index: SimulationIndex | null }>;
  chunk(sessionId: string, runId: string, sequence: number, signal?: AbortSignal): Promise<{ block: SimulationBlock; events: SimulationEvent[] }>;
  geometry(sessionId: string, runId: string, signal?: AbortSignal): Promise<SimulationNetworkView>;
  query(sessionId: string, runId: string, time: number, objectId?: string, signal?: AbortSignal, eventSequence?: number): Promise<SimulationQuery>;
};

export function createSimulationCommands(deps: CommandDeps): SimulationCommands {
  const get = <T>(sessionId: string, resource: string, signal?: AbortSignal) => httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/simulation-runs${resource}`, { signal }, { category: 'resource', sessionId }) as Promise<T>;
  const ref = (runId: string) => `/${encodeURIComponent(runId)}`;
  return {
    experiment: (sessionId, experimentId, signal) => httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/simulation-experiments/${encodeURIComponent(experimentId)}`, { signal }, { category: 'resource', sessionId }) as Promise<SimulationExperiment>,
    list: (sessionId, signal) => get(sessionId, '', signal),
    index: (sessionId, runId, signal) => get(sessionId, `${ref(runId)}/index`, signal),
    chunk: (sessionId, runId, sequence, signal) => get(sessionId, `${ref(runId)}/chunks/${sequence}`, signal),
    geometry: (sessionId, runId, signal) => get(sessionId, `${ref(runId)}/geometry`, signal),
    query: (sessionId, runId, time, objectId, signal, eventSequence) => get(sessionId, `${ref(runId)}/query?${new URLSearchParams({ time: String(time), ...(objectId ? { objectId } : {}), ...(eventSequence === undefined ? {} : { eventSequence: String(eventSequence) }) })}`, signal),
  };
}

export type ReportCommands = {
  loadSource(sessionId: string, url: string): Promise<WorkspaceFileContent>;
  exportPdf(title: string, html: string): Promise<{ url: string }>;
};

function clientCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createAgentCommands(deps: CommandDeps): AgentCommands {
  const pendingPrompts = new Map<string, { id: string; runtimeId?: string }>();
  return {
    async sendPrompt({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds, clientCommandId: requestedId }) {
      const promptKey = `${sessionId}\0${message}\0${(attachmentIds || []).join(',')}\0${(geoContextIds || []).join(',')}\0${(canvasContextIds || []).join(',')}`;
      const previous = pendingPrompts.get(promptKey);
      const commandId = requestedId || previous?.id || clientCommandId();
      const pending = previous?.id === commandId ? previous : { id: commandId };
      const runtimeId = deps.liveSessionId(sessionId);
      if (pending.runtimeId && runtimeId !== pending.runtimeId) {
        throw appError({ code: 'delivery_unknown', category: 'session', message: '上一次发送的结果未确认，会话运行实例已变更。请先检查会话历史。', sessionId, retryable: false });
      }
      pendingPrompts.set(promptKey, pending);
      // While streaming, prompts queue per session instead of hitting the
      // transport; the kernel flushes them when the run ends.
      if (deps.isStreaming(sessionId) || deps.isCompacting(sessionId)) {
        deps.dispatch({ type: 'conversation/promptQueued', sessionId, message, attachmentIds, geoContextIds, ...(canvasContextIds?.length ? { canvasContextIds } : {}), clientCommandId: commandId });
        return;
      }
      try {
        if (runtimeId) pending.runtimeId = runtimeId;
        await rpcCommand(deps, { type: 'prompt', sessionId, message, clientCommandId: commandId, ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'delivery_unknown' && code !== 'http_network_error' && pendingPrompts.get(promptKey) === pending) pendingPrompts.delete(promptKey);
        throw error;
      }
      if (pendingPrompts.get(promptKey) === pending) pendingPrompts.delete(promptKey);
      deps.dispatch({ type: 'conversation/promptSent', sessionId, message, attachmentIds, geoContextIds, ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async abort(sessionId) {
      await rpcCommand(deps, { type: 'abort', sessionId, clientCommandId: clientCommandId() });
    },

    async steer({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds }) {
      await rpcCommand(deps, { type: 'steer', sessionId, message, clientCommandId: clientCommandId(), ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async followUp({ sessionId, message }) {
      await rpcCommand(deps, { type: 'follow_up', sessionId, message, clientCommandId: clientCommandId() });
    },

    async compact(sessionId) {
      await rpcCommand(deps, { type: 'compact', sessionId });
    },

    async setAutoCompaction(sessionId, enabled) {
      await rpcCommand(deps, { type: 'set_auto_compaction', sessionId, enabled });
    },

    async getState(sessionId) {
      const data = await rpcCommand(deps, { type: 'get_state', sessionId });
      return ((data as { data?: AgentState }).data ?? {}) as AgentState;
    },

    async setModel({ sessionId, model }) {
      await rpcCommand(deps, { type: 'set_model', sessionId, model });
    },

    async setThinkingLevel({ sessionId, level }) {
      await rpcCommand(deps, { type: 'set_thinking_level', sessionId, level });
    },
  };
}

export function createCitationCommands(deps: CommandDeps): CitationCommands {
  const readEnvelope = (value: unknown, sessionId: string) => {
    const envelope = parseCitationEnvelope((value as { citations?: unknown })?.citations);
    if (envelope) return envelope;
    throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用响应无效', sessionId, retryable: false });
  };
  return {
    async list(sessionId, options = {}) {
      const query = new URLSearchParams({ offset: String(options.offset || 0) });
      if (options.ids) query.set('ids', options.ids.join(','));
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/citations?${query}`, { signal: options.signal }, { category: 'session', sessionId });
      return readEnvelope(data, sessionId);
    },
    async detail(sessionId, evidenceId, signal) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/citations/evidence/${encodeURIComponent(evidenceId)}`, { signal }, { category: 'session', sessionId });
      const detail = parseCitationDetail(data);
      if (!detail) throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用详情响应无效', sessionId, retryable: false });
      return detail;
    },
  };
}

export function createVideoCommands(deps: CommandDeps): VideoCommands {
  return {
    getMetrics(sessionId, resourceId) {
      return httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(resourceId)}/metrics`, undefined, { category: 'session', sessionId });
    },
  };
}

export function createGeoCommands(deps: CommandDeps): GeoCommands {
  const context = (sessionId: string) => ({ category: 'session' as const, sessionId });
  return {
    async createContext(sessionId, geoContext) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-contexts`, { method: 'POST', body: geoContext }, context(sessionId));
      return (data as { reference: GeoContextReferenceV1 }).reference;
    },
    async getContext(sessionId, contextId) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-contexts/${encodeURIComponent(contextId)}`, undefined, context(sessionId));
      return (data as { context: GeoClientContextV1 }).context;
    },
    async saveScreenshot(sessionId, input) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-screenshots`, { method: 'POST', body: input }, context(sessionId)) as { filename: string; path: string; bytes: number };
    },
    async respondScreenshot(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-screenshots/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId));
    },
    async respond(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-interactions/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId)) as { response: GeoInteractionResponseV1; context?: GeoClientContextV1 };
    },
  };
}

export function createCanvasCommands(deps: CommandDeps): CanvasCommands {
  return {
    async present(sessionId, input) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/canvas-presentations`, { method: 'POST', body: input }, { category: 'session', sessionId });
      return (data as { canvas: CanvasPresentationV1 }).canvas;
    },
    async createContext(sessionId, input) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/canvas-contexts`, { method: 'POST', body: input }, { category: 'session', sessionId });
      return (data as { context: CanvasContextV1 }).context;
    },
  };
}

export function createReportCommands(deps: CommandDeps): ReportCommands {
  return {
    async loadSource(sessionId, url) {
      const { content, stale } = await httpText(deps.http, url, { category: 'session', sessionId });
      return { content, encoding: 'utf8', size: new Blob([content]).size, ...(stale ? { stale: true } : {}) };
    },

    async exportPdf(title, html) {
      const data = await httpJson(deps.http, '/api/reports/pdf/download', { method: 'POST', body: { title, html } }, { category: 'session' });
      const url = typeof (data as { url?: unknown })?.url === 'string' ? (data as { url: string }).url : '';
      if (!url) throw appError({ code: 'report_export_invalid_response', category: 'session', message: 'PDF 导出响应无效', retryable: false });
      return { url };
    },
  };
}

export function createExtensionUiCommands(deps: CommandDeps): ExtensionUiCommands {
  return {
    async respond({ sessionId, id, response }) {
      // An extension response is a terminal local UI action. Pi may take time
      // to acknowledge it while continuing the run, so keep the dialog from
      // blocking the workbench after the user has made a choice.
      deps.dispatch({ type: 'extensionUi/resolved', sessionId, requestId: id });
      await rpcCommand(deps, {
        type: 'extension_ui_response',
        id,
        clientCommandId: clientCommandId(),
        ...(sessionId ? { sessionId } : {}),
        ...(response ?? { cancelled: true }),
      });
    },
  };
}

export type KernelCommands = {
  agent: AgentCommands;
  session: SessionCommands;
  citation: CitationCommands;
  video: VideoCommands;
  geo: GeoCommands;
  canvas: CanvasCommands;
  simulation: SimulationCommands;
  report: ReportCommands;
  platform: PlatformCommands;
  extensionUi: ExtensionUiCommands;
};

export function createCommands(deps: CommandDeps): KernelCommands {
  return {
    agent: createAgentCommands(deps),
    session: createSessionCommands(deps),
    citation: createCitationCommands(deps),
    video: createVideoCommands(deps),
    geo: createGeoCommands(deps),
    canvas: createCanvasCommands(deps),
    simulation: createSimulationCommands(deps),
    report: createReportCommands(deps),
    platform: createPlatformCommands(deps),
    extensionUi: createExtensionUiCommands(deps),
  };
}
