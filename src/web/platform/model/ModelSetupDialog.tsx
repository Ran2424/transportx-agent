import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PiModelApi } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';

export function ModelSetupDialog({ open, onOpenChange, onConfigured }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfigured(reference: string): void;
}) {
  const { t } = useTranslation();
  const { kernel } = useAppServices();
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [api, setApi] = useState<PiModelApi>('openai-responses');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [images, setImages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setApiKey('');
    setError('');
  }, [open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await kernel.commands.platform.addModel({ provider, modelId, name, api, baseUrl, apiKey, reasoning, images });
      setProvider('');
      setModelId('');
      setName('');
      setBaseUrl('');
      setApiKey('');
      setReasoning(false);
      setImages(false);
      onConfigured(result.reference);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('model.error.add'));
    } finally {
      setSaving(false);
    }
  }

  const apiOptions: Array<{ value: PiModelApi; label: string; metadata: string }> = [
    { value: 'openai-responses', label: 'OpenAI Responses', metadata: t('model.api.responses') },
    { value: 'openai-completions', label: 'OpenAI Chat Completions', metadata: t('model.api.completions') },
    { value: 'anthropic-messages', label: 'Anthropic Messages', metadata: t('model.api.anthropic') },
    { value: 'google-generative-ai', label: 'Google Generative AI', metadata: t('model.api.google') },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('model.setup.title')} className="model-setup-dialog">
      <form className="form-stack" onSubmit={save}>
        <div className="form-grid-two">
          <label className="field-label"><span>Provider ID</span><input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder={t('model.setup.providerExample')} autoFocus required /></label>
          <label className="field-label"><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={t('model.setup.modelExample')} required /></label>
        </div>
        <label className="field-label"><span>{t('model.setup.displayName')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('model.setup.displayNamePlaceholder')} /></label>
        <MenuSelect label={t('model.setup.apiType')} value={api} options={apiOptions} placeholder={t('model.setup.selectApi')} onChange={(value) => setApi(value as PiModelApi)} />
        <label className="field-label"><span>API Base URL</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
        <label className="field-label"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t('model.setup.apiKeyPlaceholder')} autoComplete="new-password" required /></label>
        <div className="model-capability-row">
          <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />{t('model.setup.reasoning')}</label>
          <label><input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />{t('model.setup.images')}</label>
        </div>
        <p className="field-help">{t('model.setup.help')}</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
          <Button type="submit" disabled={saving || !provider.trim() || !modelId.trim() || !baseUrl.trim() || !apiKey.trim()}>{saving ? t('common.saving') : t('model.setup.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
