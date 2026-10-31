import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';

export function ModelRefreshButton({ sessionId, disabled, onModels, onBusy }: {
  sessionId?: string;
  disabled?: boolean;
  onModels(models: Array<ModelRecord | string>): void | Promise<void>;
  onBusy?(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function refresh() {
    setBusy(true);
    onBusy?.(true);
    setMessage('');
    try {
      const result = await appKernel.commands.platform.refreshModels(sessionId);
      await onModels(result.models);
      setMessage(result.errors.map((error) => `${error.provider ? `${error.provider}: ` : ''}${error.message}`).join('\n'));
    } catch (cause) {
      setMessage((cause as { message?: string })?.message || t('model.error.list'));
    } finally { setBusy(false); onBusy?.(false); }
  }
  return <div className="model-refresh">
    <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void refresh()}>{t(busy ? 'model.refreshing' : 'model.refresh')}</Button>
    {message ? <div className="inline-error" role="alert">{message}</div> : null}
  </div>;
}
