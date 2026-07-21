import type { AppEvent } from '../app-types.js';
import { WebSocketClient } from '../websocket-client.js';
import { RuntimeStore } from './runtime-store.js';

type RuntimeTransport = EventTarget & {
  connect(): void;
  disconnect(): void;
  forceReconnect(): void;
  send(data: unknown): void;
};

export class AgentRuntime {
  readonly store = new RuntimeStore();
  readonly transport: RuntimeTransport;

  constructor(url: string, transport: RuntimeTransport = new WebSocketClient(url)) {
    this.transport = transport;
    transport.addEventListener('connected', () => this.store.patch({ connection: 'connected' }));
    transport.addEventListener('disconnected', () => this.store.patch({ connection: 'disconnected', isStreaming: false }));
    transport.addEventListener('reconnectFailed', () => this.store.patch({ connection: 'disconnected', isStreaming: false }));
    transport.addEventListener('rpcEvent', (raw: Event) => {
      const detail = (raw as CustomEvent<{ sessionId?: string; event?: AppEvent }>).detail || {};
      if (!detail.sessionId || detail.sessionId !== this.store.snapshot.activeSessionId) return;
      const type = detail.event?.type;
      if (type === 'agent_start' || type === 'turn_start') this.store.patch({ isStreaming: true });
      if (type === 'agent_end' || type === 'turn_end') this.store.patch({ isStreaming: false });
    });
    transport.addEventListener('liveSessionSnapshot', (raw: Event) => {
      const snapshot = (raw as CustomEvent<{ sessionId?: string; isStreaming?: boolean }>).detail || {};
      if (!snapshot.sessionId || snapshot.sessionId === this.store.snapshot.activeSessionId) {
        this.store.patch({ isStreaming: !!snapshot.isStreaming });
      }
    });
  }

  connect() {
    this.store.patch({ connection: 'connecting' });
    this.transport.connect();
  }

  activateSession(sessionId: string | null, isStreaming = false) {
    this.store.patch({ activeSessionId: sessionId, isStreaming: !!sessionId && isStreaming });
  }

  send(data: unknown) { this.transport.send(data); }
  forceReconnect() { this.transport.forceReconnect(); }
  disconnect() { this.transport.disconnect(); }
}
