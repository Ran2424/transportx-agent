import type { AppEvent, AppMessage } from '../app-types.js';
import type { FeatureRegistry } from '../features/feature-registry.js';
import type { StateManager } from '../state.js';
import type { ToolCardRenderer, ToolExecution, ToolResult } from '../tool-card.js';
import type { WorkspaceController } from '../workspace/workspace-controller.js';

export class ToolExecutionController {
  constructor(private readonly options: {
    state: StateManager;
    renderer: ToolCardRenderer;
    features: FeatureRegistry;
    workspace: WorkspaceController;
    formatResult: (result: unknown) => string;
    rememberDuration: (toolCallId: string, durationMs: number, sessionId: string | null) => void;
  }) {}

  start(event: AppEvent) {
    const { toolCallId, toolName, args } = event;
    if (!toolCallId) return;
    this.options.state.addToolExecution(toolCallId, {
      toolName,
      args,
      status: 'pending',
      startedAt: Date.now(),
      durationMs: 0,
    });
    const execution = this.options.state.getToolExecution(toolCallId);
    if (execution) this.options.renderer.createToolCard(execution as ToolExecution);
    this.options.workspace.refreshResourceViewIfVisible('tools');
  }

  update(event: AppEvent, sessionId: string | null) {
    const { toolCallId, partialResult } = event;
    if (!toolCallId) return;
    const execution = this.options.state.getToolExecution(toolCallId);
    const startedAt = Number(execution?.startedAt || 0);
    this.options.state.updateToolExecution(toolCallId, {
      status: 'streaming',
      output: this.options.formatResult(partialResult),
      ...(startedAt > 0 ? { durationMs: Date.now() - startedAt } : {}),
    });
    const updated = this.options.state.getToolExecution(toolCallId);
    if (updated) this.options.renderer.updateToolCard(updated as ToolExecution);
    if (sessionId) {
      const toolName = typeof execution?.toolName === 'string' ? execution.toolName : event.toolName;
      this.forwardFeatureResult(sessionId, toolName, partialResult, toolCallId, false);
    }
  }

  end(event: AppEvent, sessionId: string | null) {
    const { toolCallId, result, isError } = event;
    if (!toolCallId) return;
    const execution = this.options.state.getToolExecution(toolCallId);
    const startedAt = Number(execution?.startedAt || 0);
    const durationMs = startedAt > 0 ? Date.now() - startedAt : undefined;
    if (durationMs !== undefined) this.options.rememberDuration(toolCallId, durationMs, sessionId);
    this.options.state.updateToolExecution(toolCallId, {
      status: isError ? 'error' : 'complete',
      output: this.options.formatResult(result),
      isError,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    this.options.renderer.finalizeToolCard(toolCallId, result as ToolResult, !!isError, durationMs);
    if (!isError && sessionId) {
      const toolName = event.toolName || (typeof execution?.toolName === 'string' ? execution.toolName : undefined);
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
