import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalModelConnection, ModelProviderAccess, PiModelApi } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';

type SetupMode = 'provider' | 'local' | 'custom';
const localServices = { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1', other: '' };

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
  const [contextWindow, setContextWindow] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [images, setImages] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [localService, setLocalService] = useState<keyof typeof localServices>('other');
  const [localConnection, setLocalConnection] = useState<LocalModelConnection | null>(null);
  const [probing, setProbing] = useState(false);
  const probeGeneration = useRef(0);

  useEffect(() => {
    probeGeneration.current++;
    setProbing(false);
    setLocalConnection(null);
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
        const details = { modelId, name, baseUrl, ...(apiKey.trim() ? { apiKey } : {}), ...(contextWindow.trim() ? { contextWindow: Number(contextWindow) } : {}), ...(maxTokens.trim() ? { maxTokens: Number(maxTokens) } : {}), reasoning, images };
        const result = mode === 'local'
          ? await kernel.commands.platform.addLocalModel(details)
          : await kernel.commands.platform.addModel({ ...details, provider, api });
        setProvider('');
        setModelId('');
        setName('');
        setBaseUrl('');
        setApiKey('');
        setContextWindow('');
        setMaxTokens('');
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
  const existingCustomProvider = mode === 'custom' ? providers.find((item) => item.id === provider.trim().toLowerCase() && item.custom) : undefined;
  const canReuseCredential = !!existingCustomProvider?.connected;
  const disabled = saving || loading || probing || (mode !== 'local' && !provider.trim()) || (mode === 'provider' && !apiKey.trim())
    || (mode === 'local' && (!localConnection || !modelId || !localConnection.models.some((model) => model.id === modelId)))
    || (mode === 'custom' && (!modelId.trim() || !baseUrl.trim() || (!apiKey.trim() && !canReuseCredential)));

  function resetLocalConnection() {
    probeGeneration.current++;
    setLocalConnection(null);
    setProbing(false);
    setModelId('');
    setError('');
  }

  function changeMode(next: SetupMode) {
    resetLocalConnection();
    setMode(next);
    setProvider(next === 'provider' ? providers[0]?.id || '' : '');
    if (next === 'local' || mode === 'local') {
      setBaseUrl('');
      setApiKey('');
      setName('');
      setContextWindow('');
      setReasoning(false);
      setImages(false);
      setLocalService('other');
    }
  }

  async function detectLocalModels() {
    resetLocalConnection();
    const generation = probeGeneration.current;
    setProbing(true);
    try {
      const result = await kernel.commands.platform.discoverLocalModels({ baseUrl, ...(apiKey.trim() ? { apiKey } : {}) });
      if (probeGeneration.current !== generation) return;
      setBaseUrl(result.baseUrl);
      setLocalConnection(result);
      setModelId(result.models[0]?.id || '');
    } catch (cause) {
      if (probeGeneration.current === generation) setError((cause as { message?: string })?.message || t('model.local.error'));
    } finally {
      if (probeGeneration.current === generation) setProbing(false);
    }
  }

  function changeCustomProvider(value: string) {
    setProvider(value);
    const existing = providers.find((item) => item.id === value.trim().toLowerCase() && item.custom);
    if (existing?.baseUrl) setBaseUrl(existing.baseUrl);
    if (existing?.api) setApi(existing.api);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('model.setup.title')} className={`model-setup-dialog${mode === 'local' ? ' is-local' : ''}`}>
      <div className="model-setup-mode" role="tablist" aria-label={t('model.setup.mode')}>
        <button type="button" role="tab" disabled={saving} aria-selected={mode === 'provider'} className={mode === 'provider' ? 'is-active' : ''} onClick={() => changeMode('provider')}>{t('model.setup.builtin')}</button>
        <button type="button" role="tab" disabled={saving} aria-selected={mode === 'local'} className={mode === 'local' ? 'is-active' : ''} onClick={() => changeMode('local')}>{t('model.setup.local')}</button>
        <button type="button" role="tab" disabled={saving} aria-selected={mode === 'custom'} className={mode === 'custom' ? 'is-active' : ''} onClick={() => changeMode('custom')}>{t('model.setup.custom')}</button>
      </div>
      <form className="form-stack" onSubmit={save}>
        {mode === 'provider' ? <>
          <MenuSelect label={t('model.setup.provider')} value={provider} options={providerOptions} placeholder={loading ? t('common.loading') : t('model.setup.selectProvider')} onChange={setProvider} />
          {selectedProvider ? <div className="provider-access-summary"><span><strong>{selectedProvider.name}</strong><code>{selectedProvider.id}</code></span><small>{selectedProvider.connected ? t('model.setup.replaceKey') : t('model.setup.providerReady', { count: selectedProvider.modelCount })}</small></div> : null}
          <label className="field-label"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t('model.setup.apiKeyPlaceholder')} autoComplete="new-password" autoFocus required /></label>
          <p className="field-help">{t('model.setup.providerHelp')}</p>
        </> : mode === 'local' ? <>
          <MenuSelect label={t('model.local.service')} value={localService} placeholder={t('model.local.service')} disabled={saving} options={[
            { value: 'other', label: t('model.local.other') },
            { value: 'ollama', label: 'Ollama' },
            { value: 'lmstudio', label: 'LM Studio' },
          ]} onChange={(value) => { resetLocalConnection(); setLocalService(value as keyof typeof localServices); setBaseUrl(localServices[value as keyof typeof localServices]); }} />
          <label className="field-label"><span>{t('model.local.address')}</span><input type="url" value={baseUrl} disabled={saving} onChange={(event) => { resetLocalConnection(); setLocalService('other'); setBaseUrl(event.target.value); }} placeholder="http://127.0.0.1:8000/v1" autoFocus required /></label>
          <p className="field-help">{t('model.local.addressHelp')}</p>
          <label className="field-label"><span>{t('model.local.apiKey')}</span><input type="password" value={apiKey} disabled={saving} onChange={(event) => { resetLocalConnection(); setApiKey(event.target.value); }} placeholder={t('model.local.apiKeyPlaceholder')} autoComplete="new-password" /></label>
          <div className="model-local-detect"><Button type="button" variant="quiet" disabled={saving || probing || !baseUrl.trim()} onClick={() => { void detectLocalModels(); }}>{t(probing ? 'model.local.detecting' : 'model.local.detect')}</Button></div>
          {localConnection ? <>
            <p className="field-help" role="status">{t(localConnection.models.length ? 'model.local.connected' : 'model.local.empty', { count: localConnection.models.length })}</p>
            {localConnection.models.length ? <MenuSelect label={t('model.local.model')} placeholder={t('model.local.model')} disabled={saving} value={modelId} options={localConnection.models.map((model) => ({ value: model.id, label: model.name, metadata: model.name !== model.id ? model.id : undefined }))} onChange={setModelId} /> : null}
          </> : null}
          <details className="model-local-advanced">
            <summary>{t('model.local.advanced')}</summary>
            <div className="form-stack">
              <label className="field-label"><span>{t('model.setup.displayName')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('model.setup.displayNamePlaceholder')} /></label>
              <label className="field-label"><span>{t('model.setup.contextWindow')}</span><input type="number" min="1" step="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="128000" /></label>
      <label className="field-label"><span>{t('model.setup.maxTokens')}</span><input type="number" min="1" step="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="16384" /><small>{t('model.setup.tokenLimitsHelp')}</small></label>
              <div className="model-capability-row">
                <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />{t('model.setup.reasoning')}</label>
                <label><input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />{t('model.setup.images')}</label>
              </div>
              <p className="field-help">{t('model.local.advancedHelp')}</p>
            </div>
          </details>
        </> : <>
          <div className="form-grid-two">
            <label className="field-label"><span>Provider ID</span><input value={provider} onChange={(event) => changeCustomProvider(event.target.value)} placeholder={t('model.setup.providerExample')} autoFocus required /></label>
            <label className="field-label"><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={t('model.setup.modelExample')} required /></label>
          </div>
          <div className="form-grid-two">
            <label className="field-label"><span>{t('model.setup.displayName')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('model.setup.displayNamePlaceholder')} /></label>
            <label className="field-label"><span>{t('model.setup.contextWindow')}</span><input type="number" min="1" step="1000" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="128000" /></label>
          </div>
          <MenuSelect label={t('model.setup.apiType')} value={api} options={apiOptions} placeholder={t('model.setup.selectApi')} onChange={(value) => setApi(value as PiModelApi)} />
          <label className="field-label"><span>API Base URL</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
          <label className="field-label"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={canReuseCredential ? t('model.setup.apiKeyOptional') : t('model.setup.apiKeyPlaceholder')} autoComplete="new-password" required={!canReuseCredential} /></label>
          <div className="model-capability-row">
            <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />{t('model.setup.reasoning')}</label>
            <label><input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />{t('model.setup.images')}</label>
          </div>
          <p className="field-help">{canReuseCredential ? t('model.setup.reuseCredentialHelp') : t('model.setup.help')}</p>
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
