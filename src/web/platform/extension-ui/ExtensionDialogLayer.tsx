import { useEffect, useRef, useState } from 'react';
import type { AppEvent } from '../../../public/app-types.js';
import type { ExtensionUiPending } from '../../../public/kernel/stores/extension-ui-store.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

type Request = AppEvent & {
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: string;
};

function splitHeading(value: unknown, fallback: string) {
  const text = String(value || '').trim();
  if (!text) return { title: fallback, message: '' };
  const separator = text.indexOf(' — ');
  return separator < 0
    ? { title: text, message: '' }
    : { title: text.slice(0, separator).trim() || fallback, message: text.slice(separator + 3).trim() };
}

function splitOption(value: string) {
  const separator = value.indexOf(' — ');
  return separator < 0 ? { label: value, description: '' } : { label: value.slice(0, separator), description: value.slice(separator + 3) };
}

function ExtensionDialog({ pending }: { pending: ExtensionUiPending }) {
  const { kernel } = useAppServices();
  const request = pending.request as Request;
  const method = request.method || '';
  const fallback = method === 'select' ? '请选择' : method === 'confirm' ? '请确认' : '请输入信息';
  const heading = splitHeading(request.title, fallback);
  const message = request.message || heading.message;
  const [value, setValue] = useState(request.prefill || '');
  const resolvedRef = useRef(false);

  useEffect(() => {
    setValue(request.prefill || '');
    resolvedRef.current = false;
  }, [request.id, request.prefill]);

  async function respond(response?: Record<string, unknown>) {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    await kernel.commands.extensionUi.respond({
      sessionId: pending.sessionId,
      id: request.id,
      response,
    });
  }

  useEffect(() => {
    if (!request.timeout) return;
    const timer = window.setTimeout(() => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      void kernel.commands.extensionUi.respond({
        sessionId: pending.sessionId,
        id: request.id,
        response: { cancelled: true },
      });
    }, request.timeout);
    return () => window.clearTimeout(timer);
  }, [kernel, pending.sessionId, request.id, request.timeout]);

  const footer = method === 'confirm' ? (
    <>
      <Button variant="quiet" onClick={() => void respond({ confirmed: false })}>否</Button>
      <Button onClick={() => void respond({ confirmed: true })}>是</Button>
    </>
  ) : method === 'select' ? (
    <Button variant="quiet" onClick={() => void respond({ cancelled: true })}>取消</Button>
  ) : (
    <>
      <Button variant="quiet" onClick={() => void respond({ cancelled: true })}>取消</Button>
      <Button onClick={() => void respond(value ? { value } : { cancelled: true })}>提交回答</Button>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) void respond({ cancelled: true }); }}
      title={heading.title}
      className="extension-dialog"
      footer={footer}
    >
      {message ? <p className="extension-prompt">{message}</p> : null}
      {method === 'select' ? (
        <div className="extension-options">
          {(request.options || []).map((option) => {
            const parsed = splitOption(option);
            return <button type="button" key={option} onClick={() => void respond({ value: option })}><span><strong>{parsed.label}</strong>{parsed.description ? <small>{parsed.description}</small> : null}</span><i>→</i></button>;
          })}
        </div>
      ) : null}
      {method === 'input' ? <input className="extension-input" autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void respond(value ? { value } : { cancelled: true }); }} /> : null}
      {method === 'editor' ? <textarea className="extension-input extension-editor" autoFocus value={value} onChange={(event) => setValue(event.target.value)} /> : null}
      {!['select', 'confirm', 'input', 'editor'].includes(method) ? <div className="inline-error">不支持的 Extension UI 类型：{method || 'unknown'}</div> : null}
    </Dialog>
  );
}

export function ExtensionDialogLayer({ pending }: { pending: ExtensionUiPending | null }) {
  const { kernel } = useAppServices();
  const [notification, setNotification] = useState<Request | null>(null);
  const notificationKey = useRef('');
  const request = pending?.request as Request | undefined;

  useEffect(() => {
    if (!pending || request?.method !== 'notify') return;
    const key = `${pending.sessionId || ''}:${request.id || ''}`;
    if (notificationKey.current === key) return;
    notificationKey.current = key;
    setNotification(request);
    void kernel.commands.extensionUi.respond({ sessionId: pending.sessionId, id: request.id, response: {} });
  }, [kernel, pending, request]);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => setNotification(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notification]);

  return (
    <>
      {pending && request?.method !== 'notify' ? <ExtensionDialog key={`${pending.sessionId || ''}:${request?.id || ''}`} pending={pending} /> : null}
      {notification ? <div className={`extension-toast is-${notification.notifyType || 'info'}`} role="status"><strong>{notification.notifyType === 'error' ? '通知失败' : 'Pi 通知'}</strong><span>{notification.message}</span><button type="button" aria-label="关闭通知" onClick={() => setNotification(null)}>×</button></div> : null}
    </>
  );
}
