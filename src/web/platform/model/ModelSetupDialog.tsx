import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelProviderAccess, PiModelApi } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';

type SetupMode = 'provider' | 'custom';

export function ModelSetupDialog({ open, onOpenChange, onConfigured }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfigured(reference: string): void;
}) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [mode, setMode] = useState<SetupMode>('provider');
  const [providers, setProviders] = useState<ModelProviderAccess[]>([]);
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [api, setApi] = useState<PiModelApi>('openai-responses');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [images, setImages] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setMode('provider');
    setApiKey('');
    setError('');
    setLoading(true);
    kernel.commands.platform.getModelProviders().then((items) => {
      if (!current) return;
      const supported = items.filter((item) => item.authMethods.includes('api_key'));
      setProviders(supported);
      setProvider((selected) => supported.some((item) => item.id === selected) ? selected : (supported[0]?.id || ''));
    }).catch((cause) => {
      if (current) setError((cause as { message?: string })?.message || t('model.error.providers'));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kernel, open, t]);

  const selectedProvider = providers.find((item) => item.id === provider);
  const providerOptions = useMemo(() => providers.map((item) => ({
    value: item.id,
    label: item.name,
    metadata: item.connected
      ? t('model.setup.connectedMetadata', { count: item.modelCount })
      : t('model.setup.modelCount', { count: item.modelCount }),
  })), [providers, t]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (mode === 'provider') {
        const result = await kernel.commands.platform.connectModelProvider(provider, apiKey);
        setApiKey('');
        onConfigured(result.name || result.id);
      } else {
        const result = await kernel.commands.platform.addModel({ provider, modelId, name, api, baseUrl, apiKey, reasoning, images });
        setProvider('');
        setModelId('');
        setName('');
        setBaseUrl('');
        setApiKey('');
        setReasoning(false);
        setImages(false);
        onConfigured(result.reference);
      }
    } catch (cause) {
      setError((cause as { message?: string })?.message || t(mode === 'provider' ? 'model.error.connect' : 'model.error.add'));
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
  const disabled = saving || loading || !provider.trim() || !apiKey.trim()
    || (mode === 'custom' && (!modelId.trim() || !baseUrl.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('model.setup.title')} className="model-setup-dialog">
      <div className="model-setup-mode" role="tablist" aria-label={t('model.setup.mode')}>
        <button type="button" role="tab" aria-selected={mode === 'provider'} className={mode === 'provider' ? 'is-active' : ''} onClick={() => { setMode('provider'); setProvider(providers[0]?.id || ''); setError(''); }}>{t('model.setup.builtin')}</button>
        <button type="button" role="tab" aria-selected={mode === 'custom'} className={mode === 'custom' ? 'is-active' : ''} onClick={() => { setMode('custom'); setProvider(''); setError(''); }}>{t('model.setup.custom')}</button>
      </div>
      <form className="form-stack" onSubmit={save}>
        {mode === 'provider' ? <>
          <MenuSelect label={t('model.setup.provider')} value={provider} options={providerOptions} placeholder={loading ? t('common.loading') : t('model.setup.selectProvider')} onChange={setProvider} />
          {selectedProvider ? <div className="provider-access-summary"><span><strong>{selectedProvider.name}</strong><code>{selectedProvider.id}</code></span><small>{selectedProvider.connected ? t('model.setup.replaceKey') : t('model.setup.providerReady', { count: selectedProvider.modelCount })}</small></div> : null}
          <label className="field-label"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t('model.setup.apiKeyPlaceholder')} autoComplete="new-password" autoFocus required /></label>
          <p className="field-help">{t('model.setup.providerHelp')}</p>
        </> : <>
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
        </>}
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
          <Button type="submit" disabled={disabled}>{saving ? t('common.saving') : t(mode === 'provider' ? (selectedProvider?.connected ? 'model.setup.updateKey' : 'model.setup.connect') : 'model.setup.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
