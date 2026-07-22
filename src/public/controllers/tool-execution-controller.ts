import type { AppEvent, AppMessage } from '../app-types.js';
import type { FeatureRegistry } from '../features/feature-registry.js';
import type { ToolExecutionStore } from '../kernel/stores/tool-execution-store.js';
import type { ToolCardRenderer, ToolExecution, ToolResult } from '../tool-card.js';
import type { WorkspaceController } from '../workspace/workspace-controller.js';

/**
 * Drives ToolCardRenderer and feature result routing from tool_execution_*
 * events. The authoritative execution record lives in the kernel
 * toolExecution store (populated by the event normalizer before this
 * controller runs); only wall-clock timing (startedAt) stays local because
 * durations are a view concern and must not enter the replayable store.
 */
export class ToolExecutionController {
  private readonly startedAtByToolCall = new Map<string, number>();

  constructor(private readonly options: {
    store: ToolExecutionStore;
    renderer: ToolCardRenderer;
    features: FeatureRegistry;
    workspace: WorkspaceController;
    formatResult: (result: unknown) => string;
    rememberDuration: (toolCallId: string, durationMs: number, sessionId: string | null) => void;
  }) {}

  private getExecution(sessionId: string | null, toolCallId: string) {
    if (!sessionId) return undefined;
    return this.options.store.get().bySession[sessionId]?.[toolCallId];
  }

  start(event: AppEvent, sessionId: string | null) {
    const { toolCallId } = event;
    if (!toolCallId) return;
    const execution = this.getExecution(sessionId, toolCallId);
    const startedAt = Date.now();
    this.startedAtByToolCall.set(toolCallId, startedAt);
    this.options.renderer.createToolCard({
      toolCallId,
      toolName: execution?.toolName ?? event.toolName,
      args: execution?.args ?? event.args,
      status: 'pending',
      startedAt,
      durationMs: 0,
    } as ToolExecution);
    this.options.workspace.refreshResourceViewIfVisible('tools');
  }

  update(event: AppEvent, sessionId: string | null) {
    const { toolCallId } = event;
    if (!toolCallId) return;
    const execution = this.getExecution(sessionId, toolCallId);
    const startedAt = this.startedAtByToolCall.get(toolCallId) ?? 0;
    const partialResult = execution?.partialResult ?? event.partialResult;
    this.options.renderer.updateToolCard({
      toolCallId,
      status: 'streaming',
      output: this.options.formatResult(partialResult),
      ...(startedAt > 0 ? { durationMs: Date.now() - startedAt } : {}),
    } as ToolExecution);
    if (sessionId) {
      const toolName = execution?.toolName ?? event.toolName;
      this.forwardFeatureResult(sessionId, toolName, partialResult, toolCallId, false);
    }
  }

  end(event: AppEvent, sessionId: string | null) {
    const { toolCallId, isError } = event;
    if (!toolCallId) return;
    const execution = this.getExecution(sessionId, toolCallId);
    const startedAt = this.startedAtByToolCall.get(toolCallId) ?? 0;
    this.startedAtByToolCall.delete(toolCallId);
    const durationMs = startedAt > 0 ? Date.now() - startedAt : undefined;
    if (durationMs !== undefined) this.options.rememberDuration(toolCallId, durationMs, sessionId);
    const result = execution?.result ?? event.result;
    this.options.renderer.finalizeToolCard(toolCallId, result as ToolResult, !!isError, durationMs);
    if (!isError && sessionId) {
      const toolName = event.toolName ?? execution?.toolName;
      this.forwardFeatureResult(sessionId, toolName, result, toolCallId, true);
    }
    this.options.workspace.refreshResourceViewIfVisible('tools');
  }

  restoreToolResult(message: AppMessage, sessionId: string | null) {
    if (message.role !== 'toolResult' || !sessionId) return;
    this.forwardFeatureResult(sessionId, message.toolName, { content: message.content, details: message.details }, message.toolCallId || '', false);
  }

  private forwardFeatureResult(sessionKey: string, toolName: string | undefined, result: unknown, toolCallId: string, autoOpen: boolean) {
    const featureResult = this.options.features.handleToolResult({ sessionKey, toolName, result, autoOpen });
    if (!featureResult || featureResult.kind !== 'visualization') return;
    this.options.renderer.setVisualizationSummary(toolCallId, {
      id: featureResult.id,
      title: featureResult.title,
      revision: featureResult.revision,
      layers: featureResult.layers,
      sources: featureResult.sources,
    });
  }
}
