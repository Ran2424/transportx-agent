/**
 * Kernel transport abstraction. The kernel consumes TransportSignals instead
 * of touching WebSocket/EventTarget directly; eventTargetTransport() adapts
 * the legacy WebSocketClient (an EventTarget subclass emitting CustomEvents)
 * to this interface, and tests can inject a plain fake.
 */

export type TransportSignal =
  | { kind: 'connected' }
  | { kind: 'disconnected'; reason?: string }
  | { kind: 'message'; message: unknown };

export type KernelTransport = {
  send(data: unknown): void;
  subscribe(listener: (signal: TransportSignal) => void): () => void;
};

/** Structural subset of WebSocketClient — no DOM globals required. */
export type EventTargetTransportSource = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void;
  send(data: unknown): void;
};

type GenericListener = (event: { detail?: unknown }) => void;

/** Rebuild raw WS messages from the CustomEvents WebSocketClient dispatches. */
export function eventTargetTransport(source: EventTargetTransportSource): KernelTransport {
  const listeners = new Set<(signal: TransportSignal) => void>();
  const emit = (signal: TransportSignal) => {
    for (const listener of listeners) {
      try {
        listener(signal);
      } catch {
        // A throwing consumer must not break transport fan-out.
      }
    }
  };
  const detail = (event: { detail?: unknown }) => event.detail;

  const handlers: Array<[string, GenericListener]> = [
    ['connected', () => emit({ kind: 'connected' })],
    ['disconnected', () => emit({ kind: 'disconnected' })],
    ['rpcEvent', (event) => {
      const d = (detail(event) ?? {}) as { sessionId?: unknown; event?: unknown };
      emit({ kind: 'message', message: { type: 'event', sessionId: d.sessionId, event: d.event } });
    }],
    ['stateUpdate', (event) => emit({ kind: 'message', message: detail(event) })],
    ['liveSessionSnapshot', (event) => emit({ kind: 'message', message: detail(event) })],
    ['liveSessionCreated', (event) => emit({ kind: 'message', message: { type: 'live_session_created', session: detail(event) } })],
    ['liveSessionUpdated', (event) => emit({ kind: 'message', message: { type: 'live_session_updated', session: detail(event) } })],
    ['liveSessionClosed', (event) => emit({ kind: 'message', message: detail(event) })],
    ['serverError', (event) => emit({ kind: 'message', message: detail(event) })],
  ];
  for (const [type, handler] of handlers) {
    source.addEventListener(type, handler);
  }

  return {
    send: (data) => source.send(data),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
