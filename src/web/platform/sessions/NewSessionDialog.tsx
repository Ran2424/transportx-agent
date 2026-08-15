import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord } from '../../../public/app-types.js';
import type { SessionModuleOption } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { formatContextWindow, modelReference } from '../../lib/formatting';
import i18n from '../../i18n';

type NewSessionDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string): void;
  onAddModel(): void;
};

function normalizeModel(model: ModelRecord | string) {
  if (typeof model === 'string') return { value: model, label: model, metadata: '' };
  const reference = modelReference(model);
  const context = formatContextWindow(model.contextWindow || model.context || model.context_window);
  const abilities = [model.thinking ? i18n.t('model.ability.thinking') : '', model.images ? i18n.t('model.ability.images') : ''].filter(Boolean).join(' · ');
  return {
    value: reference,
    label: reference,
    metadata: [context ? `${context} context` : '', abilities].filter(Boolean).join(' · '),
  };
}

export function NewSessionDialog({ open, onOpenChange, onCreated, onAddModel }: NewSessionDialogProps) {
  const { t } = useTranslation();
  const { kernel } = useAppServices();
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [moduleOptions, setModuleOptions] = useState<SessionModuleOption[]>([]);
  const [selectedModules, setSelectedModules] = useState<Record<string, string>>({});
  const [city, setCity] = useState('');
  const [project, setProject] = useState('');
  const [spatialScope, setSpatialScope] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    setLoadingModels(true);
    Promise.all([
      kernel.commands.platform.getAvailableModels(kernel.stores.session.get().activeSessionId).catch(() => []),
      kernel.commands.platform.getSessionOptions().catch(() => ({ schemaVersion: 1 as const, modules: [] })),
    ])
      .then(([items, options]) => {
        if (!current) return;
        setModels(items);
        setModel(items.map(normalizeModel).find((item) => item.value)?.value || '');
        setModuleOptions(options.modules);
        setSelectedModules(Object.fromEntries(options.modules.filter((item) => item.selectedByDefault).map((item) => [item.id, item.version])));
      })
      .finally(() => { if (current) setLoadingModels(false); });
    return () => { current = false; };
  }, [kernel, open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const selected = Object.entries(selectedModules).map(([id, version]) => ({ id, version }));
      const session = await kernel.commands.session.create({
        model,
        name: name.trim(),
        profile: {
          schemaVersion: 1,
          task: {
            kind: 'data-query',
            expectedOutputs: ['answer'],
            ...(city.trim() ? { city: city.trim() } : {}),
            ...(project.trim() ? { project: project.trim() } : {}),
            ...(spatialScope.trim() ? { spatialScope: { label: spatialScope.trim() } } : {}),
            ...(timeStart && timeEnd ? { timeRange: { start: timeStart, end: timeEnd, timezone: 'Asia/Shanghai' } } : {}),
          },
          modules: { selectionMode: 'explicit', selected },
        },
      });
      kernel.dispatch({ type: 'session/created', session });
      setModel('');
      setName('');
      onOpenChange(false);
      onCreated(session.id);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('sessions.createFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  const modelOptions = models.map(normalizeModel).filter((item) => item.value);
  const moduleGroups = useMemo(() => {
    const groups = new Map<string, SessionModuleOption[]>();
    for (const option of moduleOptions.filter((item) => item.enabledForNewSessions)) groups.set(option.id, [...(groups.get(option.id) || []), option]);
    return [...groups.entries()];
  }, [moduleOptions]);
  const selectedModuleOptions = Object.entries(selectedModules).map(([id, version]) => moduleOptions.find((item) => item.id === id && item.version === version)).filter((item): item is SessionModuleOption => !!item);
  const moduleBlockers = selectedModuleOptions.flatMap((item) => item.assets.flatMap((asset) => !asset.configured ? [`${item.name}: ${asset.id} ${t('sessions.assetMissing')}`] : asset.integrity === 'missing' ? [`${item.name}: ${asset.id} ${t('sessions.integrityMissing')}`] : []));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sessions.newTask')}
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label"><span>{t('sessions.taskName')}</span><input value={name} maxLength={120} autoFocus placeholder={t('sessions.taskNamePlaceholder')} onChange={(event) => setName(event.target.value)} /></label>
        {moduleGroups.length ? (
          <fieldset className="session-module-fieldset">
            <legend>{t('sessions.modules')}</legend>
            {moduleGroups.map(([id, versions]) => (
              <div className="session-module-row" key={id}>
                <label>
                  <input
                    type="checkbox"
                    checked={id in selectedModules}
                    onChange={(event) => setSelectedModules((current) => {
                      if (event.target.checked) return { ...current, [id]: versions.find((item) => item.selectedByDefault)?.version || versions.at(-1)!.version };
                      const next = { ...current };
                      delete next[id];
                      return next;
                    })}
                  />
                  <span>{versions[0].name}</span>
                  <small className="session-module-status">{versions.flatMap((item) => item.assets).length ? versions.find((item) => item.version === selectedModules[id])?.assets.map((asset) => `${asset.kind}: ${asset.configured ? t(`sessions.integrity.${asset.integrity}`) : t('sessions.assetMissing')}`).join(' · ') : t('sessions.noAssets')}</small>
                </label>
                <select
                  aria-label={t('sessions.moduleVersion', { name: versions[0].name })}
                  value={selectedModules[id] || versions.find((item) => item.selectedByDefault)?.version || versions.at(-1)!.version}
                  disabled={!(id in selectedModules)}
                  onChange={(event) => setSelectedModules((current) => ({ ...current, [id]: event.target.value }))}
                >
                  {versions.map((item) => <option value={item.version} key={item.version}>{item.version}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
        ) : null}
        {moduleBlockers.length ? <div className="inline-error" role="alert">{moduleBlockers.join('；')}</div> : null}
        <details className="session-profile-details">
          <summary>{t('sessions.taskContext')}</summary>
          <div className="form-stack">
            <div className="form-grid-two">
              <label className="field-label"><span>{t('sessions.city')}</span><input value={city} onChange={(event) => setCity(event.target.value)} /></label>
              <label className="field-label"><span>{t('sessions.project')}</span><input value={project} onChange={(event) => setProject(event.target.value)} /></label>
            </div>
            <label className="field-label"><span>{t('sessions.spatialScope')}</span><input value={spatialScope} onChange={(event) => setSpatialScope(event.target.value)} /></label>
            <div className="form-grid-two">
              <label className="field-label"><span>{t('sessions.timeStart')}</span><input type="datetime-local" value={timeStart} onChange={(event) => setTimeStart(event.target.value)} /></label>
              <label className="field-label"><span>{t('sessions.timeEnd')}</span><input type="datetime-local" min={timeStart} value={timeEnd} onChange={(event) => setTimeEnd(event.target.value)} /></label>
            </div>
          </div>
        </details>
        <div className="field-with-action">
          <MenuSelect
            label={t('sessions.model')}
            value={model}
            options={modelOptions}
            placeholder={loadingModels ? t('sessions.loadingModels') : t('sessions.noModels')}
            disabled={loadingModels || modelOptions.length === 0}
            onChange={setModel}
          />
          <Button type="button" variant="outline" onClick={onAddModel}>{t('sessions.addModel')}</Button>
        </div>
        <p className="field-help">{t('sessions.workspaceHelp')}</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
          <Button type="submit" disabled={submitting || !model || moduleBlockers.length > 0}>{submitting ? t('sessions.starting') : t('sessions.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
