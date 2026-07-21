/**
 * Dialogs - Handles extension UI dialogs
 */

export type DialogRequest = {
  id?: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  sessionId?: string;
  method?: string;
  [key: string]: unknown;
};

export class DialogHandler {
  container: HTMLElement;
  wsClient: { send(data: unknown): void };
  getSessionId: (() => string | null) | null;
  currentDialog: HTMLElement | null;
  currentRequest: ({ sessionId?: string | null; request?: DialogRequest | null } & Record<string, unknown>) | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
  onIdle: (() => void) | null;

  constructor(container: HTMLElement, wsClient: { send(data: unknown): void }, getSessionId: (() => string | null) | null = null) {
    this.container = container;
    this.wsClient = wsClient;
    this.getSessionId = getSessionId;
    this.currentDialog = null;
    this.currentRequest = null;
    this.timeoutId = null;
    this.onIdle = null;
  }

  showSelect(request: DialogRequest) {
    this.cancelCurrentDialog(true);

    const { id, title, options, timeout, sessionId } = request;
    const heading = this.splitDialogHeading(title, '请选择');

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog--choice';
    dialog.innerHTML = `
      <div class="dialog-eyebrow"><span></span> PI 需要你的选择</div>
      <div class="dialog-title">${this.escapeHtml(heading.title)}</div>
      ${heading.message ? `<div class="dialog-message">${this.escapeHtml(heading.message)}</div>` : ''}
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button class="dialog-secondary" id="dialog-cancel">取消</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options')!;
    
    (options || []).forEach((option: string) => {
      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'dialog-option';
      const parsed = this.splitOption(option);
      const label = document.createElement('span');
      label.className = 'dialog-option-label';
      label.textContent = parsed.label;
      optionButton.appendChild(label);
      if (parsed.description) {
        const description = document.createElement('span');
        description.className = 'dialog-option-description';
        description.textContent = parsed.description;
        optionButton.appendChild(description);
      }
      const arrow = document.createElement('span');
      arrow.className = 'dialog-option-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      optionButton.appendChild(arrow);
      optionButton.onclick = () => {
        this.respond(id, { value: option }, sessionId);
      };
      optionsContainer.appendChild(optionButton);
    });

    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showConfirm(request: DialogRequest) {
    this.cancelCurrentDialog(true);

    const { id, title, message, timeout, sessionId } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog--confirm';
    dialog.innerHTML = `
      <div class="dialog-eyebrow"><span></span> PI 需要你的确认</div>
      <div class="dialog-title">${this.escapeHtml(title || '确认')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button class="dialog-secondary" id="dialog-no">否</button>
        <button class="dialog-primary" id="dialog-yes">是</button>
      </div>
    `;

    dialog.querySelector('#dialog-yes')!.onclick = () => {
      this.respond(id, { confirmed: true }, sessionId);
    };

    dialog.querySelector('#dialog-no')!.onclick = () => {
      this.respond(id, { confirmed: false }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
  }

  showInput(request: DialogRequest) {
    this.cancelCurrentDialog(true);

    const { id, title, placeholder, timeout, sessionId } = request;
    const heading = this.splitDialogHeading(title, '请输入信息');

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog--input';
    dialog.innerHTML = `
      <div class="dialog-eyebrow"><span></span> PI 正在等待</div>
      <div class="dialog-title">${this.escapeHtml(heading.title)}</div>
      ${heading.message ? `<div class="dialog-message">${this.escapeHtml(heading.message)}</div>` : ''}
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button class="dialog-secondary" id="dialog-cancel">取消</button>
        <button class="dialog-primary" id="dialog-submit">提交回答</button>
      </div>
    `;

    const input = dialog.querySelector<HTMLInputElement>('#dialog-input');
    if (!input) return;
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    input.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit')!.onclick = submit;
    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request: DialogRequest) {
    this.cancelCurrentDialog(true);

    const { id, title, prefill, timeout, sessionId } = request;
    const heading = this.splitDialogHeading(title, '补充详细信息');

    const dialog = document.createElement('div');
    dialog.className = 'dialog dialog--editor';
    dialog.innerHTML = `
      <div class="dialog-eyebrow"><span></span> PI 正在等待</div>
      <div class="dialog-title">${this.escapeHtml(heading.title)}</div>
      ${heading.message ? `<div class="dialog-message">${this.escapeHtml(heading.message)}</div>` : ''}
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button class="dialog-secondary" id="dialog-cancel">取消</button>
        <button class="dialog-primary" id="dialog-save">提交回答</button>
      </div>
    `;

    const textarea = dialog.querySelector<HTMLTextAreaElement>('#dialog-textarea');
    if (!textarea) return;

    dialog.querySelector('#dialog-save')!.onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true }, sessionId);
    };

    dialog.querySelector('#dialog-cancel')!.onclick = () => {
      this.respond(id, { cancelled: true }, sessionId);
    };

    this.showDialog(dialog, timeout, id, sessionId, request);
    
    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request: DialogRequest) {
    const { message, notifyType } = request;
    
    // Create a temporary notification element
    const notification = document.createElement('div');
    notification.className = 'error-message';
    notification.textContent = `${notifyType === 'error' ? '⚠️' : notifyType === 'warning' ? '⚠️' : 'ℹ️'} ${message}`;
    
    // Add to messages container temporarily
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      // Remove after 5 seconds
      setTimeout(() => {
        notification.remove();
      }, 5000);
    }
  }

  showDialog(dialogElement: HTMLElement, timeout: number | undefined, requestId: string | undefined, sessionId: string | null = null, request: DialogRequest | null = null) {
    this.currentDialog = dialogElement;
    this.currentRequest = { id: requestId, sessionId, request };
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true }, sessionId);
      }, timeout);
    }
  }

  cancelCurrentDialog(suppressIdle = false) {
    if (!this.currentRequest?.id) {
      this.clearCurrentDialog();
      return;
    }
    const { id, sessionId } = this.currentRequest;
    this.clearCurrentDialog();
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      sessionId: sessionId || this.getSessionId?.(),
      cancelled: true,
    });
    if (!suppressIdle) this.onIdle?.();
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.currentRequest = null;
  }

  respond(id: string | undefined, response: Record<string, unknown>, sessionId: string | null = null) {
    this.clearCurrentDialog();
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      sessionId: sessionId || this.getSessionId?.(),
      ...response
    });
    this.onIdle?.();
  }

  splitDialogHeading(value: string | undefined, fallback: string) {
    const text = String(value || '').trim();
    if (!text) return { title: fallback, message: '' };
    const separator = text.indexOf(' — ');
    if (separator < 0) return { title: text, message: '' };
    return {
      title: text.slice(0, separator).trim() || fallback,
      message: text.slice(separator + 3).trim(),
    };
  }

  splitOption(value: string) {
    const separator = value.indexOf(' — ');
    if (separator < 0) return { label: value, description: '' };
    return { label: value.slice(0, separator), description: value.slice(separator + 3) };
  }

  escapeHtml(text: string) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
