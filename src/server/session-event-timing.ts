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
  assistantMessageEvent?: { type?: unknown; delta?: unknown };
  message?: TimingMessage;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  workingStartedAt?: number | null;
  workingDurationMs?: number;
};

export class SessionEventTiming {
  workingStartedAt: number | null = null;
  workingDurationMs: number | undefined;
  private workingClock: number | null = null;
  private assistantThinkingStartedAt: number | null = null;
  private assistantThinkingDurationMs: number | null = null;
  private readonly toolStartedAt = new Map<string, number>();

  constructor(private readonly metrics: TimingMetricsStore) {}

  get workingElapsedMs() { return this.workingClock === null ? undefined : Math.max(0, performance.now() - this.workingClock); }

  apply(event: TimingEvent, now = Date.now()) {
    const type = event.type;
    const deltaType = event.assistantMessageEvent?.type;
    const assistant = event.message?.role === 'assistant';
    const workingBefore = this.workingStartedAt;
    if (this.workingStartedAt === null && (type === 'agent_start' || type === 'message_start' && assistant || type === 'tool_execution_start' || type === 'message_update' && typeof deltaType === 'string' && deltaType.startsWith('toolcall_'))) {
      this.workingStartedAt = now;
      this.workingClock = performance.now();
    }
    if (type === 'message_start' && assistant) this.workingDurationMs = undefined;
    const content = event.message?.content;
    const hasText = type === 'message_end' && assistant && (typeof content === 'string' ? !!content.trim() : content?.some((block) => block.type === 'text' && typeof block.text === 'string' && !!block.text.trim()));
    const textStarted = type === 'message_update' && deltaType === 'text_delta' && typeof event.assistantMessageEvent?.delta === 'string' && !!event.assistantMessageEvent.delta.trim();
    if ((textStarted || hasText) && this.workingDurationMs === undefined && this.workingStartedAt !== null) {
      this.workingDurationMs = event.workingDurationMs = this.workingElapsedMs;
      this.workingStartedAt = null;
    }
    if (type === 'agent_settled') this.workingStartedAt = null;
    if (this.workingStartedAt === null) this.workingClock = null;
    if (workingBefore !== this.workingStartedAt) event.workingStartedAt = this.workingStartedAt;
    if (type === 'message_start' && event.message?.role === 'assistant') {
      this.assistantThinkingStartedAt = now;
      this.assistantThinkingDurationMs = null;
      event.message = { ...event.message, startedAt: now };
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
      if (hasText && this.workingDurationMs !== undefined) event.message = this.metrics.recordWorking(event.message, this.workingDurationMs);
      if (startedAt !== null && hasThinking) {
        const durationMs = this.assistantThinkingDurationMs ?? Math.max(0, now - startedAt);
        event.message = this.metrics.recordThinking(event.message, startedAt, startedAt + durationMs, durationMs);
      }
      this.workingDurationMs = undefined;
      this.assistantThinkingStartedAt = null;
      this.assistantThinkingDurationMs = null;
    }
    if (type === 'message_end' && event.message?.role === 'toolResult') {
      event.message = this.metrics.enrichToolResult(event.message);
    }
  }
}
