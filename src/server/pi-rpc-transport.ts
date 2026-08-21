import type { PendingCommand, RpcCommand, RpcResponse } from './types.js';

type WritableInput = {
  writable: boolean;
  write(payload: string, callback: (error?: Error | null) => void): unknown;
};

export class PiRpcTransport {
  private readonly pending = new Map<string, PendingCommand>();

  send(input: WritableInput, command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outbound = { ...command, id };
    delete outbound.sessionId;
    if (outbound.type === 'extension_ui_response') {
      return new Promise<RpcResponse>((resolve, reject) => {
        try {
          input.write(JSON.stringify(outbound) + '\n', (error) => error ? reject(error) : resolve({ type: 'response', command: outbound.type, success: true, id }));
        } catch (error) { reject(error); }
      });
    }
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${outbound.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        input.write(JSON.stringify(outbound) + '\n', (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  resolve(response: RpcResponse) {
    const id = response.id;
    if (typeof id !== 'string') return false;
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
    return true;
  }

  rejectAll(error: unknown) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
