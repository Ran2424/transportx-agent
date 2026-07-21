export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type RuntimeState = {
  connection: ConnectionState;
  isStreaming: boolean;
  activeSessionId: string | null;
};

export class RuntimeStore {
  private state: RuntimeState = { connection: 'disconnected', isStreaming: false, activeSessionId: null };
  private readonly listeners = new Set<(state: RuntimeState) => void>();

  get snapshot() { return this.state; }

  subscribe(listener: (state: RuntimeState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  patch(update: Partial<RuntimeState>) {
    const next = { ...this.state, ...update };
    if (next.connection === this.state.connection && next.isStreaming === this.state.isStreaming && next.activeSessionId === this.state.activeSessionId) return;
    this.state = next;
    for (const listener of this.listeners) listener(this.state);
  }
}
