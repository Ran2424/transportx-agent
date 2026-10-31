import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord } from '../../../public/app-types.js';
import type { ModelProviderAccess } from '../../../public/kernel/commands.js';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/icons';
import i18n from '../../i18n';
import { formatContextWindow } from '../../lib/formatting';
import { ModelRefreshButton } from './ModelRefreshButton';

type Props = {
  models: Array<ModelRecord | string>;
  modelProviders: ModelProviderAccess[];
  modelsLoading: boolean;
  busy: string;
  sessionId?: string;
  onAddModel(): void;
  onModels(models: Array<ModelRecord | string>): Promise<void>;
  setDisconnectTarget(value: { id: string; name: string }): void;
  setDeleteProviderTarget(value: { id: string; name: string }): void;
  setDeleteModelTarget(value: { provider: string; modelId: string; name: string }): void;
  setEditModelTarget(value: { provider: string; model: ModelRecord }): void;
};

function modelDetails(model: ModelRecord | string) {
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    return { raw: null, modelId: slash > 0 ? model.slice(slash + 1) : model, provider: slash > 0 ? model.slice(0, slash) : i18n.t('settings.model.unknownProvider'), name: slash > 0 ? model.slice(slash + 1) : model, context: '', reasoning: false, images: false };
  }
  const modelId = model.id || model.model || model.name || '';
  const name = model.name || model.label || model.id || model.model || i18n.t('settings.model.unnamed');
  const contextValue = model.contextWindow || model.context || model.context_window;
  const context = formatContextWindow(contextValue);
  return { raw: model, modelId, provider: model.provider || i18n.t('settings.model.unknownProvider'), name, context, reasoning: model.thinking === true || model.thinking === 'true', images: model.images === true || model.images === 'true' };
}

function providerInitial(name: string, id: string) {
  const source = (name || id).trim();
  return source ? source.slice(0, 1).toLocaleUpperCase() : '?';
}

export function ModelAccessPanel({ models, modelProviders, modelsLoading, busy, sessionId, onAddModel, onModels, setDisconnectTarget, setDeleteProviderTarget, setDeleteModelTarget, setEditModelTarget }: Props) {
  const { t } = useTranslation();
  const [modelQuery, setModelQuery] = useState('');
  const [modelCapability, setModelCapability] = useState<'all' | 'reasoning' | 'images'>('all');
  const [providerMenu, setProviderMenu] = useState<string | null>(null);
  const modelDetailsList = useMemo(() => models.map(modelDetails), [models]);
  const providerMetadata = new Map(modelProviders.map((provider) => [provider.id, provider]));
  const connectedProviders = Object.entries(modelDetailsList.reduce<Record<string, ReturnType<typeof modelDetails>[]>>((groups, model) => {
    (groups[model.provider] ||= []).push(model);
    return groups;
  }, {})).map(([id, providerModels]) => ({
    id,
    models: providerModels,
    metadata: providerMetadata.get(id),
    name: providerMetadata.get(id)?.name || id,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const filteredProviders = connectedProviders.map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => {
      const query = modelQuery.trim().toLocaleLowerCase();
      const matchesQuery = !query || `${provider.name} ${provider.id} ${model.name}`.toLocaleLowerCase().includes(query);
      const matchesCapability = modelCapability === 'all' || model[modelCapability];
      return matchesQuery && matchesCapability;
    }),
  })).filter((provider) => provider.models.length);
  const reasoningModelCount = modelDetailsList.filter((model) => model.reasoning).length;
  const imageModelCount = modelDetailsList.filter((model) => model.images).length;
  const modelAccessStats = [
    { label: t('settings.modelStat.providers'), value: connectedProviders.length },
    { label: t('settings.modelStat.models'), value: modelDetailsList.length },
    { label: t('settings.modelStat.reasoning'), value: reasoningModelCount },
    { label: t('settings.modelStat.images'), value: imageModelCount },
  ];
  return (
<section className="settings-section">
          <div className="model-access-panel">
          <header className="model-access-heading">
            <div>
              <h2>{t('settings.modelAccess')}</h2>
              <p>{t('settings.connectedModelsHelp')}</p>
              <div className="model-access-stats" aria-label={t('settings.modelSummary', { providers: connectedProviders.length, models: modelDetailsList.length })}>
                {modelAccessStats.map((item) => <span key={item.label}><strong>{item.value}</strong><small>{item.label}</small></span>)}
              </div>
            </div>
            <div className="model-access-actions"><ModelRefreshButton key={sessionId} sessionId={sessionId} disabled={modelsLoading || !!busy} onModels={onModels} /><Button type="button" onClick={onAddModel}><Icon name="plus" />{t('sessions.addModel')}</Button></div>
          </header>
          {modelsLoading ? <div className="settings-loading" aria-label={t('settings.loadingModels')}><span /></div> : connectedProviders.length ? <>
            <div className="model-access-toolbar"><label><Icon name="search" /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t('settings.searchModelsPlaceholder')} aria-label={t('settings.searchModels')} /></label><select value={modelCapability} onChange={(event) => setModelCapability(event.target.value as typeof modelCapability)} aria-label={t('settings.filterModels')}><option value="all">{t('settings.filter.all')}</option><option value="reasoning">{t('settings.model.reasoning')}</option><option value="images">{t('settings.model.images')}</option></select></div>
            {filteredProviders.length ? <div className="model-provider-list">{filteredProviders.map((provider) => {
              const providerSource = provider.metadata?.custom ? t('settings.providerSource.custom') : t('settings.providerSource.pi');
              const credentialSource = provider.metadata?.credentialStored ? t('settings.providerCredential.local') : t('settings.providerCredential.external');
              return <article className="model-provider" key={provider.id}>
                <header className="model-provider-heading">
                  <span className="model-provider-title">
                    <span className="model-provider-avatar" aria-hidden="true">{providerInitial(provider.name, provider.id)}</span>
                    <span className="model-provider-identity"><strong>{provider.name}</strong><span><code>{provider.id}</code><small>{providerSource} · {credentialSource}</small></span></span>
                  </span>
                  <span className="model-provider-meta"><i><b />{t('settings.providerConnected')}</i><small>{t('settings.modelCount', { count: provider.models.length })}</small>{provider.metadata?.custom || provider.metadata?.credentialStored ? <button className="model-provider-more" type="button" aria-label={t('settings.providerActions')} aria-expanded={providerMenu === provider.id} onClick={() => setProviderMenu((current) => current === provider.id ? null : provider.id)}>•••</button> : null}{providerMenu === provider.id ? <span className="model-provider-menu">{provider.metadata?.custom ? <button type="button" disabled={busy === `model-delete-provider:${provider.id}`} onClick={() => { setProviderMenu(null); setDeleteProviderTarget({ id: provider.id, name: provider.name }); }}>{t('settings.deleteProvider')}</button> : <button type="button" disabled={busy === `model-disconnect:${provider.id}`} onClick={() => { setProviderMenu(null); setDisconnectTarget({ id: provider.id, name: provider.name }); }}>{t('settings.disconnectProvider')}</button>}</span> : null}</span>
                </header>
                <div className="model-provider-content">{provider.models.map((model) => <div className="model-provider-row" key={`${provider.id}:${model.modelId}`}>
                  <span className="model-provider-model-identity"><strong>{model.name}</strong><code>{model.modelId}</code></span>
                  <span className="model-capability-grid">
                    <span className={`model-capability-chip${model.context ? ' is-on' : ''}`}><small>{t('settings.model.contextShort')}</small><strong>{model.context || t('settings.model.notSet')}</strong></span>
                    <span className={`model-capability-chip${model.reasoning ? ' is-on' : ''}`}><small>{t('settings.model.reasoning')}</small><strong>{model.reasoning ? t('common.yes') : t('common.no')}</strong></span>
                    <span className={`model-capability-chip${model.images ? ' is-on' : ''}`}><small>{t('settings.model.images')}</small><strong>{model.images ? t('common.yes') : t('common.no')}</strong></span>
                    <span className="model-row-actions">{model.raw ? <Button type="button" variant="quiet" onClick={() => setEditModelTarget({ provider: provider.id, model: model.raw! })}>{t('settings.editModelShort')}</Button> : null}{provider.metadata?.custom && model.raw ? <Button type="button" variant="quiet" disabled={busy === `model-delete:${provider.id}/${model.modelId}`} onClick={() => setDeleteModelTarget({ provider: provider.id, modelId: model.modelId, name: model.name })}>{t('settings.deleteModelShort')}</Button> : null}</span>
                  </span>
                </div>)}</div>
              </article>;
            })}</div> : <p className="settings-empty">{t('settings.noMatchingModels')}</p>}
          </> : <p className="settings-empty">{t('settings.noConnectedModels')}</p>}
          <p className="settings-model-restart-note">{t('settings.modelRestartNote')}</p>
          </div>
        </section>
  );
}
