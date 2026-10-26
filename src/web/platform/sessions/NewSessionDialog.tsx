import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord, WorkspaceView } from '../../../public/app-types.js';
import type { SessionProfileV1 } from '../../../contracts/session-profile.js';
import type { SessionModuleOption } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { formatModelOption } from '../../lib/formatting';
import { WorkspaceLocation } from './WorkspaceLocation';
import { moduleDisplayMetadata, modulePresentation } from '../../lib/module-presentation';

type NewSessionDialogProps = {
  open: boolean;
  workspace: WorkspaceView | null;
  workspaces: WorkspaceView[];
  mode: 'create' | 'defaults' | 'confirmation';
  confirmationId?: string;
  onWorkspaceChange(workspace: WorkspaceView | null): void;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string, fromQuickCreate?: boolean): void;
  onAddModel(): void;
  quickCreate?: boolean;
  onQuickCreateFinished(): void;
};

export function NewSessionDialog({ open, workspace, workspaces, mode, confirmationId, onWorkspaceChange, onOpenChange, onCreated, onAddModel, quickCreate = false, onQuickCreateFinished }: NewSessionDialogProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const kernel = appKernel;
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [parentDirectory, setParentDirectory] = useState('');
  const [locationMode, setLocationMode] = useState<'new' | 'folder'>('folder');
  const [directory, setDirectory] = useState('');
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const desktop = (window as Window & { transportxDesktop?: { selectWorkspaceDirectory?(): Promise<string | null> } }).transportxDesktop;
  const requestIds = useRef(new Map<string, string>());
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [moduleOptions, setModuleOptions] = useState<SessionModuleOption[]>([]);
  const [selectedModules, setSelectedModules] = useState<Record<string, string>>({});
  const [city, setCity] = useState('');
  const [project, setProject] = useState('');
  const [spatialScope, setSpatialScope] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [loadingModels, setLoadingModels] = useState(true);
  const [quickCreating, setQuickCreating] = useState(quickCreate);
  const quickAttempted = useRef(false);
  const [advanced, setAdvanced] = useState(mode !== 'create');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [reload, setReload] = useState(0);
  const configurationOwner = useRef('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    const owner = workspace ? `${workspace.id}:${workspace.defaultsRevision}` : 'new';
    const initialize = configurationOwner.current !== owner;
    setLoadingModels(true); setLoadFailed(false);
    Promise.all([
      kernel.commands.platform.getAvailableModels(),
      kernel.commands.platform.getSessionOptions(),
    ])
      .then(([items, options]) => {
        if (!current) return;
        setModels(items);
        setModel(current => (!initialize && current) || workspace?.defaults?.modelSpec || items.map(formatModelOption).find((item) => item.reference)?.reference || '');
        setModuleOptions(options.modules);
        if (initialize) {
          const task = workspace?.defaults?.profile?.task;
          setCity(task?.city || ''); setProject(task?.project || ''); setSpatialScope(task?.spatialScope?.label || ''); setTimeStart(task?.timeRange?.start || ''); setTimeEnd(task?.timeRange?.end || '');
          setSelectedModules(workspace?.defaults?.profile ? Object.fromEntries(workspace.defaults.profile.modules.selected.map((item) => [item.id, item.version])) : Object.fromEntries(options.modules.filter((item) => item.selectedByDefault).map((item) => [item.id, item.version])));
          configurationOwner.current = owner;
        }
      })
      .catch(cause => { if (current) { setError((cause as Error).message); setAdvanced(true); setLoadFailed(true); } })
      .finally(() => { if (current) setLoadingModels(false); });
    return () => { current = false; };
  }, [kernel, open, workspace, reload]);

  function selectFolder(value: string) {
    setDirectory(value);
    const canonical = value.replaceAll('\\', '/').replace(/\/$/, '');
    const registered = workspaces.find((item) => item.availability === 'ready' && item.kind !== 'standalone' && item.path === canonical);
    if (registered) { onWorkspaceChange(registered); return; }
    if (workspace) onWorkspaceChange(null);
    if (!workspaceName.trim() || workspaceName === directory.replaceAll('\\', '/').replace(/\/$/, '').split('/').at(-1)) setWorkspaceName(canonical.split('/').at(-1) || '');
  }

  async function chooseDirectory() {
    setChoosingDirectory(true); setError('');
    try {
      const selected = await desktop?.selectWorkspaceDirectory?.();
      if (selected) { setLocationMode('folder'); selectFolder(selected); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setChoosingDirectory(false); }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const selected = Object.entries(selectedModules).map(([id, version]) => ({ id, version }));
      const profile: SessionProfileV1 = {
        schemaVersion: 1,
        task: { ...(workspace?.defaults?.profile?.task || { kind: 'data-query', expectedOutputs: ['answer'] }), city: city.trim() || undefined, project: project.trim() || undefined, spatialScope: spatialScope === (workspace?.defaults?.profile?.task.spatialScope?.label || '') ? workspace?.defaults?.profile?.task.spatialScope : spatialScope.trim() ? { label: spatialScope.trim() } : undefined, timeRange: timeStart === (workspace?.defaults?.profile?.task.timeRange?.start || '') && timeEnd === (workspace?.defaults?.profile?.task.timeRange?.end || '') ? workspace?.defaults?.profile?.task.timeRange : timeStart && timeEnd ? { start: timeStart, end: timeEnd, timezone: workspace?.defaults?.profile?.task.timeRange?.timezone || 'Asia/Shanghai' } : undefined },
        modules: { selectionMode: 'explicit', selected },
      };
      const domainId = workspace?.defaults?.domainId || 'com.transportx.workbench';
      if (mode === 'defaults') {
        if (!workspace || workspace.defaultsRevision === null) throw new Error(t('workspaceFlow.reload'));
        await kernel.commands.session.updateWorkspace(workspace.id, { expectedDefaultsRevision: workspace.defaultsRevision, defaults: { domainId, modelSpec: model, profile } });
        await kernel.commands.session.list(); onOpenChange(false); return;
      }
      if (mode === 'confirmation') {
        if (!workspace || workspace.revision === null || !confirmationId) throw new Error(t('workspaceFlow.reload'));
        await kernel.commands.session.activate(confirmationId, { confirmCurrentConfiguration: { expectedRevision: workspace.revision, domainId, modelSpec: model, profile } });
        await kernel.commands.session.list(); onCreated(confirmationId); onOpenChange(false); return;
      }
      const input = { workspace: workspace ? { kind: 'existing' as const, workspaceId: workspace.id, expectedRevision: workspace.revision!, defaultsRevision: workspace.defaultsRevision! } : locationMode === 'folder' ? { kind: 'folder' as const, name: workspaceName.trim(), directory: directory.trim() } : { kind: 'new' as const, name: workspaceName.trim(), ...(parentDirectory.trim() ? { parentDirectory: parentDirectory.trim() } : {}) }, name: name.trim() || t(workspace ? 'workspaceFlow.untitled' : 'workspaceFlow.initialAnalysis'), model, profile, domainId };
      const digest = JSON.stringify(input), requestId = requestIds.current.get(digest) || crypto.randomUUID(); requestIds.current.set(digest, requestId);
      const session = await kernel.commands.session.create({ ...input, requestId });
      kernel.dispatch({ type: 'session/created', session });
      await kernel.commands.session.list();
      setModel('');
      setName('');
      onOpenChange(false);
      onCreated(session.id, quickCreating);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('sessions.createFailed'));
      setAdvanced(true);
      setRevisionConflict((cause as { code?: string }).code === 'workspace_revision_conflict');
    } finally {
      setSubmitting(false);
      if (quickCreating) { setQuickCreating(false); onQuickCreateFinished(); }
    }
  }

  const modelOptions = models.map(formatModelOption).filter((item) => item.reference).map((item) => ({ value: item.reference, label: item.label, metadata: item.metadata })).concat([{ value: '__add_model__', label: t('sessions.addModel'), metadata: '' }]);
  const moduleGroups = useMemo(() => {
    const groups = new Map<string, SessionModuleOption[]>();
    for (const option of moduleOptions.filter((item) => item.enabledForNewSessions)) groups.set(option.id, [...(groups.get(option.id) || []), option]);
    return [...groups.entries()];
  }, [moduleOptions]);
  const selectedModuleOptions = Object.entries(selectedModules).map(([id, version]) => moduleOptions.find((item) => item.id === id && item.version === version)).filter((item): item is SessionModuleOption => !!item);
  const moduleBlockers = selectedModuleOptions.flatMap((item) => item.assets.flatMap((asset) => {
    const name = modulePresentation(item, language).name;
    const assetName = moduleDisplayMetadata(item)?.assets?.[asset.id] ? modulePresentation(item, language, { assetId: asset.id }).name : asset.id;
    return !asset.configured ? [`${name}: ${assetName} ${t('sessions.assetMissing')}`] : asset.integrity === 'missing' ? [`${name}: ${assetName} ${t('sessions.integrityMissing')}`] : [];
  }));

  const unavailableModules = Object.entries(selectedModules).filter(([id, version]) => !moduleOptions.some(item => item.id === id && item.version === version && item.enabledForNewSessions));
  const modelUnavailable = !!model && !modelOptions.some(item => item.value === model);
  const blocked = moduleBlockers.length > 0 || unavailableModules.length > 0 || modelUnavailable;
  useEffect(() => { if (blocked) setAdvanced(true); }, [blocked]);
  useEffect(() => {
    if (!open || !quickCreating || loadingModels || quickAttempted.current) return;
    quickAttempted.current = true;
    if (mode !== 'create' || !workspace?.defaults?.profile || !workspace.defaults.domainId || !workspace.defaults.modelSpec || !model || blocked || error) {
      setQuickCreating(false); setAdvanced(true); onQuickCreateFinished(); return;
    }
    void submit();
  }, [open, quickCreating, loadingModels, workspace, model, blocked, error]);

  const moduleFields = (
          <fieldset className="session-module-fieldset" aria-label={t('sessions.modules')}>
            <legend>{t('sessions.modules')}</legend>
            {moduleGroups.map(([id, versions]) => {
              const selected = versions.find((item) => item.version === selectedModules[id]) || versions.find((item) => item.selectedByDefault) || versions.at(-1)!;
              const display = modulePresentation(selected, language);
              return (
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
                  <span title={id}>{display.name}</span>{display.description ? <small className="session-module-description">{display.description}</small> : null}{display.features.length ? <small className="session-module-description">{display.features.join(' · ')}</small> : null}
                  <small className="session-module-status">{versions.flatMap((item) => item.assets).length ? versions.find((item) => item.version === selectedModules[id])?.assets.map((asset) => `${t(`capability.category.${asset.kind}`)}: ${asset.configured ? t(`sessions.integrity.${asset.integrity}`) : t('sessions.assetMissing')}`).join(' · ') : t('sessions.noAssets')}</small>
                </label>
                <select
                  aria-label={t('sessions.moduleVersion', { name: display.name })}
                  value={selectedModules[id] || versions.find((item) => item.selectedByDefault)?.version || versions.at(-1)!.version}
                  disabled={!(id in selectedModules)}
                  onChange={(event) => setSelectedModules((current) => ({ ...current, [id]: event.target.value }))}
                >
                  {versions.map((item) => <option value={item.version} key={item.version}>{item.version}</option>)}
                </select>
              </div>
              );
            })}
          </fieldset>
  );

  return (
    <Dialog
      open={open && !quickCreating}
      onOpenChange={onOpenChange}
      onEscapeKeyDown={event => { if (event.target instanceof Element && (event.target.closest('[role=listbox]') || event.target.closest('[aria-haspopup=listbox][aria-expanded=true]'))) event.preventDefault(); }}
      title={mode === 'defaults' ? t('workspaceFlow.defaults') : mode === 'confirmation' ? t('workspaceFlow.confirmation') : workspace ? t('workspaceFlow.newConversation') : t('workspaceFlow.openWorkspace')}
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        {mode === 'create' ? <WorkspaceLocation workspace={workspace} workspaces={workspaces} locationMode={locationMode} directory={directory} parentDirectory={parentDirectory} name={workspaceName} nativePicker={!!desktop?.selectWorkspaceDirectory} busy={choosingDirectory || submitting} onWorkspaceChange={onWorkspaceChange} onLocationModeChange={setLocationMode} onDirectoryChange={selectFolder} onParentChange={setParentDirectory} onNameChange={setWorkspaceName} onChooseDirectory={() => void chooseDirectory()} /> : <p className="confirmation-dialog-copy">{workspace?.name}<br />{mode === 'confirmation' ? t('workspaceFlow.missingPlan') : t('workspaceFlow.futureOnly')}</p>}
        <div className="workspace-model-row"><MenuSelect compact portal label={t('sessions.model')} value={model} options={modelOptions} placeholder={loadingModels ? t('sessions.loadingModels') : t('sessions.noModels')} disabled={loadingModels || submitting} onChange={value => value === '__add_model__' ? onAddModel() : setModel(value)} /><small>{workspace?.defaults?.modelSpec === model ? t('workspaceFlow.defaultModel') : t('workspaceFlow.sessionModel')}</small></div>
        {!loadingModels && modelUnavailable && <div className="inline-error" role="alert">{t('workspaceFlow.modelUnavailable')}</div>}
        {moduleBlockers.length ? <div className="inline-error" role="alert">{moduleBlockers.join('；')}</div> : null}
        {unavailableModules.length ? <div className="inline-error" role="alert">{t('workspaceFlow.unavailableModules', { modules: unavailableModules.map(([id, version]) => `${id}@${version}`).join(', ') })}{unavailableModules.map(([id]) => <Button type="button" variant="quiet" key={id} onClick={() => setSelectedModules(current => { const next = { ...current }; delete next[id]; return next; })}>{t('workspaceFlow.removeSelection', { name: id })}</Button>)}</div> : null}
        <details className="workspace-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary><span>{t('workspaceFlow.advanced')}</span><small>{t('workspaceFlow.configurationSummary', { count: Object.keys(selectedModules).length })}{city || spatialScope || timeStart ? ` · ${t('sessions.taskContext')}` : ''}</small></summary>
          <div className="workspace-advanced-body">
            {mode === 'create' && <label className="field-label"><span>{t('sessions.taskName')}</span><input value={name} maxLength={120} placeholder={t('sessions.taskNamePlaceholder')} onChange={event => setName(event.target.value)} /></label>}
            {moduleGroups.length ? moduleFields : null}
        <details className="session-profile-details">
          <summary>{t('sessions.taskContext')}</summary>
          <div className="form-stack">
            <div className="form-grid-two">
              <label className="field-label"><span>{t('sessions.city')}</span><input value={city} onChange={(event) => setCity(event.target.value)} /></label>
              <label className="field-label"><span>{t('sessions.project')}</span><input value={project} onChange={(event) => setProject(event.target.value)} /></label>
            </div>
            <label className="field-label"><span>{t('sessions.spatialScope')}</span><input value={spatialScope} onChange={(event) => setSpatialScope(event.target.value)} /></label>
            <div className="form-grid-two">
              <label className="field-label"><span>{t('workspaceFlow.timeStart', { timezone: workspace?.defaults?.profile?.task.timeRange?.timezone || 'Asia/Shanghai' })}</span><input type="datetime-local" value={timeStart} onChange={(event) => setTimeStart(event.target.value)} /></label>
              <label className="field-label"><span>{t('workspaceFlow.timeEnd', { timezone: workspace?.defaults?.profile?.task.timeRange?.timezone || 'Asia/Shanghai' })}</span><input type="datetime-local" min={timeStart} value={timeEnd} onChange={(event) => setTimeEnd(event.target.value)} /></label>
            </div>
          </div>
        </details>
          </div>
        </details>
        {error ? <div className="inline-error" role="alert">{error}{revisionConflict && workspace && <Button type="button" variant="quiet" onClick={async () => { try { await kernel.commands.session.list(); const current = kernel.stores.session.get().workspaces.find(item => item.id === workspace.id); if (current) { onWorkspaceChange(current); setRevisionConflict(false); setError(''); } } catch (cause) { setError((cause as Error).message); } }}>{t('workspaceFlow.reloadConfiguration')}</Button>}{loadFailed && <Button type="button" variant="quiet" onClick={() => setReload(value => value + 1)}>{t('common.retry')}</Button>}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
          <Button type="submit" disabled={submitting || choosingDirectory || loadingModels || loadFailed || revisionConflict || !model || blocked || mode === 'create' && !workspace && (!workspaceName.trim() || locationMode === 'folder' && !directory.trim())}>{submitting ? t('common.saving') : mode === 'defaults' ? t('workspaceFlow.saveDefaults') : mode === 'confirmation' ? t('workspaceFlow.confirmActivate') : workspace ? t('workspaceFlow.create') : t('workspaceFlow.enterWorkspace')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
