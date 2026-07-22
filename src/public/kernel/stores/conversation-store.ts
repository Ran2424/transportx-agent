/**
 * Conversation store: Stable Snapshot + Live Overlay per session
 * (migration plan §4.4).
 *
 * - snapshotEntries are only replaced/merged on hydrate and deterministic
 *   reconcile points (message_end, agent_end, new snapshot) — never per token.
 * - Token deltas, optimistic prompts and queued messages live in the overlay.
 * - Reconcile merges overlay content into entries, or replaces it with the
 *   authoritative message_end payload; reconnect snapshots never duplicate
 *   entries that already exist (dedup by entry id / message content key).
 */

import type { AppMessage, MessageContentBlock, PendingImage, SessionEntry, SessionSnapshot } from '../../app-types.js';
import { createStore, type Store, type StoreListener } from '../store.js';

export type QueuedPrompt = { message: string; images?: PendingImage[] };
export type OptimisticPrompt = { message: string; images?: PendingImage[] };

export type LiveOverlay = {
  runId: string | null;
  optimisticPrompt: OptimisticPrompt | null;
  streamingText: string;
  streamingThinking: string;
  active: boolean;
  queued: QueuedPrompt[];
};

export type ConversationState = {
  snapshotEntries: SessionEntry[];
  live: LiveOverlay;
};

export type ConversationStoreState = {
  bySession: Record<string, ConversationState>;
};

const emptyOverlay = (): LiveOverlay => ({
  runId: null,
  optimisticPrompt: null,
  streamingText: '',
  streamingThinking: '',
  active: false,
  queued: [],
});

const emptyConversation = (): ConversationState => ({ snapshotEntries: [], live: emptyOverlay() });

export function messageText(message: AppMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

export function messageThinking(message: AppMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b?.type === 'thinking')
    .map((b) => b.thinking || b.text || '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Dedup key shared by live-appended and snapshot-hydrated entries. Message
 * entries key on responseId first (identical across live event and JSONL
 * projection), then toolCallId, then role/timestamp/text. Non-message
 * entries fall back to entry id, then full content.
 */
function entryKey(entry: SessionEntry): string {
  const message = entry.message;
  if (message) {
    const responseId = (message as Record<string, unknown>).responseId;
    if (typeof responseId === 'string' && responseId) return `resp:${responseId}`;
    if (message.toolCallId) return `tool:${message.toolCallId}:${message.role ?? ''}`;
    return `msg:${message.role ?? ''}:${message.timestamp ?? ''}:${messageText(message)}`;
  }
  const id = (entry as Record<string, unknown>).id;
  if (typeof id === 'string' && id) return `id:${id}`;
  return `entry:${JSON.stringify(entry)}`;
}

function appendDedup(entries: SessionEntry[], entry: SessionEntry): SessionEntry[] {
  const key = entryKey(entry);
  return entries.some((existing) => entryKey(existing) === key) ? entries : [...entries, entry];
}

/** Replace the text blocks of a message with a single authoritative text. */
function overrideBlock(message: AppMessage, blockType: 'text' | 'thinking', field: 'text' | 'thinking', value: string): AppMessage {
  if (!Array.isArray(message.content)) {
    return { ...message, content: [{ type: blockType, [field]: value } as MessageContentBlock] };
  }
  let replaced = false;
  const content: MessageContentBlock[] = [];
  for (const block of message.content) {
    if (block?.type === blockType) {
      if (!replaced) {
        content.push({ ...block, [field]: value });
        replaced = true;
      }
      // Drop further blocks of this type; the local buffer is a single string.
    } else {
      content.push(block);
    }
  }
  if (!replaced) content.unshift({ type: blockType, [field]: value } as MessageContentBlock);
  return { ...message, content };
}

export class ConversationStore {
  private readonly store: Store<ConversationStoreState> = createStore<ConversationStoreState>({ bySession: {} });

  get(): ConversationStoreState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<ConversationStoreState>): () => void {
    return this.store.subscribe(listener);
  }

  private update(sessionId: string, fn: (conv: ConversationState) => ConversationState) {
    this.store.set((prev) => {
      const conv = prev.bySession[sessionId] ?? emptyConversation();
      return { bySession: { ...prev.bySession, [sessionId]: fn(conv) } };
    });
  }

  streamStarted(sessionId: string, runId: string) {
    this.update(sessionId, (conv) => ({ ...conv, live: { ...conv.live, runId, active: true } }));
  }

  messageStarted(sessionId: string, message: AppMessage) {
    this.update(sessionId, (conv) => {
      if (message?.role === 'assistant') {
        // A new assistant message within the same run resets the buffers.
        return { ...conv, live: { ...conv.live, streamingText: '', streamingThinking: '' } };
      }
      if (message?.role === 'user') {
        const text = messageText(message);
        // Echo of our own optimistic prompt: clear it instead of appending.
        if (conv.live.optimisticPrompt && conv.live.optimisticPrompt.message === text) {
          return { ...conv, live: { ...conv.live, optimisticPrompt: null } };
        }
        return { ...conv, snapshotEntries: appendDedup(conv.snapshotEntries, { type: 'message', message }) };
      }
      return conv;
    });
  }

  streamDelta(sessionId: string, channel: 'text' | 'thinking', delta: string) {
    this.update(sessionId, (conv) => ({
      ...conv,
      live: {
        ...conv.live,
        streamingText: channel === 'text' ? conv.live.streamingText + delta : conv.live.streamingText,
        streamingThinking: channel === 'thinking' ? conv.live.streamingThinking + delta : conv.live.streamingThinking,
      },
    }));
  }

  /**
   * message_end is authoritative: when the payload text is at least as long
   * as the locally streamed text it wins; otherwise (client attached earlier
   * than the payload accounts for) the local buffer is kept. This mirrors
   * the legacy handleMessageEnd correction semantics.
   */
  streamCompleted(sessionId: string, message: AppMessage) {
    this.update(sessionId, (conv) => {
      if (message?.role === 'assistant') {
        let finalMessage = message;
        const localText = conv.live.streamingText;
        const localThinking = conv.live.streamingThinking;
        if (localText.length > messageText(message).length) {
          finalMessage = overrideBlock(finalMessage, 'text', 'text', localText);
        }
        if (localThinking.length > messageThinking(message).length) {
          finalMessage = overrideBlock(finalMessage, 'thinking', 'thinking', localThinking);
        }
        return {
          snapshotEntries: appendDedup(conv.snapshotEntries, { type: 'message', message: finalMessage }),
          live: { ...conv.live, streamingText: '', streamingThinking: '' },
        };
      }
      if (message) {
        return { ...conv, snapshotEntries: appendDedup(conv.snapshotEntries, { type: 'message', message }) };
      }
      return conv;
    });
  }

  /** agent_end: fold any leftover overlay content into entries, then reset. */
  streamEnded(sessionId: string) {
    this.update(sessionId, (conv) => ({
      snapshotEntries: this.foldOverlay(conv, conv.snapshotEntries),
      live: { ...emptyOverlay(), optimisticPrompt: conv.live.optimisticPrompt, queued: conv.live.queued },
    }));
  }

  appendEntry(sessionId: string, entry: SessionEntry) {
    this.update(sessionId, (conv) => ({ ...conv, snapshotEntries: appendDedup(conv.snapshotEntries, entry) }));
  }

  promptSent(sessionId: string, prompt: OptimisticPrompt) {
    this.update(sessionId, (conv) => ({ ...conv, live: { ...conv.live, optimisticPrompt: prompt } }));
  }

  promptQueued(sessionId: string, prompt: QueuedPrompt) {
    this.update(sessionId, (conv) => ({ ...conv, live: { ...conv.live, queued: [...conv.live.queued, prompt] } }));
  }

  removeQueued(sessionId: string, index: number) {
    this.update(sessionId, (conv) => ({
      ...conv,
      live: { ...conv.live, queued: conv.live.queued.filter((_, i) => i !== index) },
    }));
  }

  queueDrained(sessionId: string) {
    this.update(sessionId, (conv) => (conv.live.queued.length === 0 ? conv : { ...conv, live: { ...conv.live, queued: [] } }));
  }

  /** Append overlay content unless an existing assistant entry already covers it. */
  private foldOverlay(conv: ConversationState, entries: SessionEntry[]): SessionEntry[] {
    const { streamingText, streamingThinking } = conv.live;
    if (!streamingText && !streamingThinking) return entries;
    const covered = entries.some((entry) =>
      entry.message?.role === 'assistant'
      && messageText(entry.message).includes(streamingText)
      && messageThinking(entry.message).includes(streamingThinking));
    if (covered) return entries;
    const content: MessageContentBlock[] = [];
    if (streamingThinking) content.push({ type: 'thinking', thinking: streamingThinking });
    if (streamingText) content.push({ type: 'text', text: streamingText });
    return appendDedup(entries, { type: 'message', message: { role: 'assistant', content } });
  }

  /**
   * Snapshot hydration reuses the same reconcile rules as live events:
   * merge entries with dedup; when the server says the session is not
   * streaming, reconcile the overlay once and reset it.
   */
  hydrate(sessionId: string, snapshot: SessionSnapshot) {
    this.update(sessionId, (conv) => {
      let entries = conv.snapshotEntries;
      for (const entry of snapshot.entries ?? []) entries = appendDedup(entries, entry);
      if (snapshot.isStreaming) {
        return { snapshotEntries: entries, live: { ...conv.live, active: true } };
      }
      const withOverlay = this.foldOverlay({ ...conv, snapshotEntries: entries }, entries);
      return {
        snapshotEntries: withOverlay,
        live: { ...emptyOverlay(), optimisticPrompt: conv.live.optimisticPrompt, queued: conv.live.queued },
      };
    });
  }

  dropSession(sessionId: string) {
    this.store.set((prev) => {
      if (!(sessionId in prev.bySession)) return prev;
      const bySession = { ...prev.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  }
}
