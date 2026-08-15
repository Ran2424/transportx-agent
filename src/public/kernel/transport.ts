/**
 * Kernel transport abstraction. The kernel consumes TransportSignals instead
 * of touching WebSocket directly; the browser WebSocketClient implements this
 * interface, and tests can inject a plain fake.
 */

export type TransportSignal =
  | { kind: 'connected' }
  | { kind: 'disconnected'; reason?: string }
  | { kind: 'message'; message: unknown };

export type KernelTransport = {
  send(data: unknown): void;
  subscribe(listener: (signal: TransportSignal) => void): () => void;
};
