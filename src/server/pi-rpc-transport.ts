import type { PendingCommand, RpcCommand, RpcResponse } from './types.js';

type WritableInput = {
  writable: boolean;
  write(payload: string, callback: (error?: Error | null) => void): unknown;
};

export class PiRpcTransport {
  get pendingCount() { return this.pending.size; }
  private readonly pending = new Map<string, PendingCommand>();
  private readonly late = new Map<string, (response: RpcResponse) => void>();

  send(input: WritableInput, command: RpcCommand, opts: { timeoutMs?: number; onLateResponse?: (response: RpcResponse) => void } = {}) {
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
        if (opts.onLateResponse && this.late.size < 200) this.late.set(id, opts.onLateResponse);
        reject(Object.assign(new Error(`RPC command timed out: ${outbound.type}`), { delivery: 'unknown' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        input.write(JSON.stringify(outbound) + '\n', (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(Object.assign(error, { delivery: 'unknown' }));
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
    if (!pending) {
      const late = this.late.get(id);
      if (!late) return false;
      this.late.delete(id);
      late(response);
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
    return true;
  }

  rejectAll(error: unknown) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(error instanceof Error ? error.message : String(error)), { delivery: 'unknown' }));
    }
    this.pending.clear();
    this.late.clear();
  }
}
