import type { JsonRecord, ModelIdentity } from './types.js';
import { modelLabel } from './model-utils.js';

export type SessionMetadataSource = {
  id: string;
  pid: number | null;
  cwd: string;
  modelSpec: string;
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  createdAt: string;
  lastActiveAt: string;
  lastConversationAt: string;
  contextUsage: JsonRecord | null;
  resolvedSessionPlan: unknown;
};

export function sessionMetadata(source: SessionMetadataSource, capabilities: unknown, pendingExtensionUiRequests: unknown[]) {
  return {
    id: source.id,
    pid: source.pid,
    cwd: source.cwd,
    modelSpec: source.modelSpec,
    model: source.model,
    modelLabel: modelLabel(source.model, source.modelSpec),
    thinkingLevel: source.thinkingLevel,
    sessionFile: source.sessionFile,
    sessionName: source.sessionName,
    isStreaming: source.isStreaming,
    isCompacting: source.isCompacting,
    autoCompactionEnabled: source.autoCompactionEnabled,
    createdAt: source.createdAt,
    lastActiveAt: source.lastActiveAt,
    lastConversationAt: source.lastConversationAt,
    contextUsage: source.contextUsage,
    pendingExtensionUiRequests,
    capabilities,
    resolvedSessionPlan: source.resolvedSessionPlan,
  };
}

export function liveSessionMetadata(source: SessionMetadataSource, capabilities: unknown) {
  return {
    id: source.id,
    modelSpec: source.modelSpec,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
    sessionFile: source.sessionFile,
    sessionName: source.sessionName,
    isStreaming: source.isStreaming,
    isCompacting: source.isCompacting,
    autoCompactionEnabled: source.autoCompactionEnabled,
    lastConversationAt: source.lastConversationAt,
    contextUsage: source.contextUsage,
    capabilities,
  };
}

export function sessionSnapshot(projectionSnapshot: object, source: SessionMetadataSource, capabilities: unknown, pendingExtensionUiRequests: unknown[]) {
  return {
    ...projectionSnapshot,
    session: sessionMetadata(source, capabilities, pendingExtensionUiRequests),
    model: source.model,
    thinkingLevel: source.thinkingLevel,
    isStreaming: source.isStreaming,
    isCompacting: source.isCompacting,
    sessionFile: source.sessionFile,
    sessionName: source.sessionName,
    contextUsage: source.contextUsage,
  };
}
