import type { TimingMetricsStore } from './timing-metrics.js';

type TimingMessage = {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  toolCallId?: string;
  [key: string]: unknown;
};

type TimingEvent = {
  type?: string;
  toolCallId?: unknown;
  assistantMessageEvent?: { type?: unknown };
  message?: TimingMessage;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
};

export class SessionEventTiming {
  private assistantThinkingStartedAt: number | null = null;
  private assistantThinkingDurationMs: number | null = null;
  private readonly toolStartedAt = new Map<string, number>();

  constructor(private readonly metrics: TimingMetricsStore) {}

  apply(event: TimingEvent, now = Date.now()) {
    const type = event.type;
    if (type === 'message_start' && event.message?.role === 'assistant') {
      this.assistantThinkingStartedAt = now;
      this.assistantThinkingDurationMs = null;
    }
    if (type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta' && this.assistantThinkingStartedAt !== null && this.assistantThinkingDurationMs === null) {
      this.assistantThinkingDurationMs = Math.max(0, now - this.assistantThinkingStartedAt);
    }
    if (type === 'tool_execution_start' && typeof event.toolCallId === 'string' && event.toolCallId) {
      this.toolStartedAt.set(event.toolCallId, now);
      event.startedAt = now;
    }
    if (type === 'tool_execution_end' && typeof event.toolCallId === 'string' && event.toolCallId) {
      const startedAt = this.toolStartedAt.get(event.toolCallId);
      if (startedAt !== undefined) {
        const durationMs = Math.max(0, now - startedAt);
        event.startedAt = startedAt;
        event.endedAt = now;
        event.durationMs = durationMs;
        this.metrics.recordTool(event.toolCallId, startedAt, now, durationMs);
        this.toolStartedAt.delete(event.toolCallId);
      }
    }
    if (type === 'message_end' && event.message?.role === 'assistant') {
      const startedAt = this.assistantThinkingStartedAt;
      const hasThinking = Array.isArray(event.message.content) && event.message.content.some((block) => block.type === 'thinking');
      if (startedAt !== null && hasThinking) {
        const durationMs = this.assistantThinkingDurationMs ?? Math.max(0, now - startedAt);
        event.message = this.metrics.recordThinking(event.message, startedAt, startedAt + durationMs, durationMs);
      }
      this.assistantThinkingStartedAt = null;
      this.assistantThinkingDurationMs = null;
    }
    if (type === 'message_end' && event.message?.role === 'toolResult') {
      event.message = this.metrics.enrichToolResult(event.message);
    }
  }
}
