import type { AppEvent } from '../app-types.js';

type DialogRequest = AppEvent & { sessionId?: string };
type DialogPort = {
  currentRequest: ({ sessionId?: string | null; request?: DialogRequest | null } & Record<string, unknown>) | null;
  clearCurrentDialog(): void;
  showSelect(request: DialogRequest): void;
  showConfirm(request: DialogRequest): void;
  showInput(request: DialogRequest): void;
  showEditor(request: DialogRequest): void;
  showNotification(request: DialogRequest): void;
};

type PendingRequest = { sessionId: string; event: AppEvent };

export class ExtensionUIController {
  private readonly pending: PendingRequest[] = [];

  constructor(private readonly options: {
    dialogs: DialogPort;
    activeSessionId: () => string | null;
    isActiveSessionVisible: () => boolean;
    onChange: () => void;
  }) {}

  hasPending(sessionId: string) { return this.pending.some((request) => request.sessionId === sessionId); }

  enqueue(event: AppEvent, sessionId: string | null) {
    if (!sessionId) return this.show(event, null);
    if (!this.pending.some((request) => request.sessionId === sessionId && request.event.id === event.id)) {
      this.pending.push({ sessionId, event });
      this.options.onChange();
    }
  }

  process(sessionId = this.options.activeSessionId()) {
    if (!sessionId || !this.options.isActiveSessionVisible() || sessionId !== this.options.activeSessionId() || this.options.dialogs.currentRequest) return;
    const index = this.pending.findIndex((request) => request.sessionId === sessionId);
    if (index === -1) return;
    const [{ event }] = this.pending.splice(index, 1);
    this.options.onChange();
    this.show(event, sessionId);
  }

  suspendForSession(nextSessionId: string) {
    const current = this.options.dialogs.currentRequest;
    if (!current?.sessionId || current.sessionId === nextSessionId) return;
    const event = current.request;
    if (event && !this.pending.some((request) => request.sessionId === current.sessionId && request.event.id === event.id)) {
      this.pending.unshift({ sessionId: current.sessionId, event });
    }
    this.options.dialogs.clearCurrentDialog();
    this.options.onChange();
  }

  dropSession(sessionId: string) {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index].sessionId === sessionId) this.pending.splice(index, 1);
    }
  }

  show(event: AppEvent, sessionId: string | null) {
    const request = (sessionId ? { ...event, sessionId } : event) as DialogRequest;
    if (event.method === 'select') this.options.dialogs.showSelect(request);
    else if (event.method === 'confirm') this.options.dialogs.showConfirm(request);
    else if (event.method === 'input') this.options.dialogs.showInput(request);
    else if (event.method === 'editor') this.options.dialogs.showEditor(request);
    else if (event.method === 'notify') this.options.dialogs.showNotification(request);
    else console.warn('[ExtensionUI] Unknown method:', event.method);
  }
}
