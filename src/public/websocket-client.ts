/**
 * WebSocket Client - Handles connection to backend WebSocket server.
 *
 * Implements the KernelTransport contract directly: parsed JSON messages are
 * delivered to subscribers as TransportSignals without an intermediate
 * DOM CustomEvent protocol.
 */

import type { KernelTransport, TransportSignal } from './kernel/transport.js';

export class WebSocketClient implements KernelTransport {
  url: string;
  ws: WebSocket | null;
  reconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  isIntentionallyClosed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectionState: 'idle' | 'connecting' | 'open' | 'closed';
  private readonly listeners = new Set<(signal: TransportSignal) => void>();

  constructor(url: string) {
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = 'idle';
  }

  subscribe(listener: (signal: TransportSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(signal: TransportSignal) {
    for (const listener of this.listeners) {
      try {
        listener(signal);
      } catch {
        // A throwing consumer must not break transport fan-out.
      }
    }
  }

  connect() {
    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'open';
      this.emit({ kind: 'connected' });
    };

    this.ws.onmessage = (event) => {
      try {
        this.emit({ kind: 'message', message: JSON.parse(event.data) });
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.emit({ kind: 'disconnected', reason: event.reason || undefined });

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  // Force reconnect — resets attempt counter and connects fresh
  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = 'closed';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'force reconnect'); } catch (e) {}
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

}
