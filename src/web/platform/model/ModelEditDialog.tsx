import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { formatContextWindow } from '../../lib/formatting';

function booleanValue(value: unknown) {
  return value === true || value === 'true';
}

export function ModelEditDialog({ open, onOpenChange, provider, model, onSaved }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  provider: string;
  model: ModelRecord | null;
  onSaved(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [images, setImages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !model) return;
    setName(String(model.name || model.label || ''));
    const context = Number(model.contextWindow || model.context || model.context_window);
    setContextWindow(Number.isFinite(context) && context > 0 ? String(context) : '');
    setReasoning(booleanValue(model.thinking));
    setImages(booleanValue(model.images));
    setError('');
  }, [open, model]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!model?.id && !model?.model) return;
    setSaving(true);
    setError('');
    try {
      await appKernel.commands.platform.updateModel({
        provider,
        modelId: String(model.id || model.model),
        name,
        ...(contextWindow.trim() ? { contextWindow: Number(contextWindow) } : {}),
        reasoning,
        images,
      });
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.updateModel'));
    } finally {
      setSaving(false);
    }
  }

  const modelId = model?.id || model?.model || '';
  const contextLabel = contextWindow ? formatContextWindow(contextWindow) : t('settings.model.notSet');
  return <Dialog open={open} onOpenChange={onOpenChange} title={t('settings.editModel')} className="model-edit-dialog">
    <form className="form-stack" onSubmit={save}>
      <div className="model-edit-identity"><span>{t('settings.model.id')}</span><code>{provider}/{modelId}</code></div>
      <label className="field-label"><span>{t('model.setup.displayName')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('model.setup.displayNamePlaceholder')} autoFocus /></label>
      <label className="field-label"><span>{t('model.setup.contextWindow')} <small>{contextLabel}</small></span><input type="number" min="1" step="1000" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="128000" /></label>
      <div className="model-capability-row">
        <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />{t('model.setup.reasoning')}</label>
        <label><input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />{t('model.setup.images')}</label>
      </div>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="form-actions"><DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose><Button type="submit" disabled={!modelId || saving}>{saving ? t('common.saving') : t('common.save')}</Button></div>
    </form>
  </Dialog>;
}
