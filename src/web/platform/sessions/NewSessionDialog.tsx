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
import { projectUi } from '../../app/project-ui';
import { moduleDisplayMetadata, modulePresentation } from '../../lib/module-presentation';

type NewSessionDialogProps = {
  open: boolean;
  workspace: WorkspaceView | null;
  workspaces: WorkspaceView[];
  mode: 'create' | 'defaults' | 'confirmation';
  confirmationId?: string;
  onWorkspaceChange(workspace: WorkspaceView | null): void;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string): void;
  onAddModel(): void;
};

export function NewSessionDialog({ open, workspace, workspaces, mode, confirmationId, onWorkspaceChange, onOpenChange, onCreated, onAddModel }: NewSessionDialogProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const kernel = appKernel;
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [parentDirectory, setParentDirectory] = useState('');
  const requestIds = useRef(new Map<string, string>());
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
    setError(''); requestIds.current.clear();
    const task = workspace?.defaults?.profile?.task;
    setCity(task?.city || ''); setProject(task?.project || ''); setSpatialScope(task?.spatialScope?.label || ''); setTimeStart(task?.timeRange?.start || ''); setTimeEnd(task?.timeRange?.end || '');
    setLoadingModels(true);
    Promise.all([
      kernel.commands.platform.getAvailableModels(kernel.stores.session.get().activeSessionId).catch(() => []),
      kernel.commands.platform.getSessionOptions().catch(() => ({ schemaVersion: 1 as const, modules: [] })),
    ])
      .then(([items, options]) => {
        if (!current) return;
        setModels(items);
        setModel(workspace?.defaults?.modelSpec || items.map(formatModelOption).find((item) => item.reference)?.reference || '');
        setModuleOptions(options.modules);
        setSelectedModules(workspace?.defaults?.profile ? Object.fromEntries(workspace.defaults.profile.modules.selected.map((item) => [item.id, item.version])) : Object.fromEntries(options.modules.filter((item) => item.selectedByDefault).map((item) => [item.id, item.version])));
      })
      .finally(() => { if (current) setLoadingModels(false); });
    return () => { current = false; };
  }, [kernel, open, workspace]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const selected = Object.entries(selectedModules).map(([id, version]) => ({ id, version }));
      const profile: SessionProfileV1 = {
        schemaVersion: 1,
        task: { ...(workspace?.defaults?.profile?.task || { kind: 'data-query', expectedOutputs: ['answer'] }), city: city.trim() || undefined, project: project.trim() || undefined, spatialScope: spatialScope.trim() ? { label: spatialScope.trim() } : undefined, timeRange: timeStart && timeEnd ? { start: timeStart, end: timeEnd, timezone: 'Asia/Shanghai' } : undefined },
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
        await kernel.commands.session.list(); onOpenChange(false); onCreated(confirmationId); return;
      }
      const input = { workspace: workspace ? { kind: 'existing' as const, workspaceId: workspace.id, expectedRevision: workspace.revision!, defaultsRevision: workspace.defaultsRevision! } : { kind: 'new' as const, name: workspaceName.trim(), ...(parentDirectory.trim() ? { parentDirectory: parentDirectory.trim() } : {}) }, name: name.trim() || t(workspace ? 'workspaceFlow.untitled' : 'workspaceFlow.initialAnalysis'), model, profile, domainId };
      const digest = JSON.stringify(input), requestId = requestIds.current.get(digest) || crypto.randomUUID(); requestIds.current.set(digest, requestId);
      const session = await kernel.commands.session.create({ ...input, requestId });
      kernel.dispatch({ type: 'session/created', session });
      await kernel.commands.session.list();
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

  const modelOptions = models.map(formatModelOption).filter((item) => item.reference).map((item) => ({ value: item.reference, label: item.label, metadata: item.metadata }));
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

  const moduleFields = (
          <fieldset className="session-module-fieldset" aria-label={t('sessions.modules')}>
            {!projectUi.moduleOptionsCollapsed ? <legend>{t('sessions.modules')}</legend> : null}
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
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'defaults' ? t('workspaceFlow.defaults') : mode === 'confirmation' ? t('workspaceFlow.confirmation') : t('workspaceFlow.newConversation')}
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        {mode === 'create' && <label className="field-label"><span>{t('workspaceFlow.workspace')}</span><select value={workspace?.id || ''} onChange={(event) => onWorkspaceChange(workspaces.find((item) => item.id === event.target.value) || null)}><option value="">{t('workspaceFlow.newWorkspace')}</option>{workspaces.filter((item) => item.availability === 'ready').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {mode === 'create' && !workspace && <><label className="field-label"><span>{t('workspaceFlow.name')}</span><input value={workspaceName} maxLength={120} required onChange={(event) => setWorkspaceName(event.target.value)} /></label><label className="field-label"><span>{t('workspaceFlow.parent')}</span><input value={parentDirectory} placeholder={t('workspaceFlow.defaultParent')} onChange={(event) => setParentDirectory(event.target.value)} /></label></>}
        {workspace && <p className="confirmation-dialog-copy">{workspace.name} · {workspace.path}<br />{mode === 'confirmation' ? t('workspaceFlow.missingPlan') : t('workspaceFlow.futureOnly')}</p>}
        {mode === 'create' && <label className="field-label"><span>{t('sessions.taskName')}</span><input value={name} maxLength={120} autoFocus placeholder={t('sessions.taskNamePlaceholder')} onChange={(event) => setName(event.target.value)} /></label>}
        {moduleGroups.length ? (
          projectUi.moduleOptionsCollapsed ? <details className="session-profile-details"><summary>{t('sessions.modules')}</summary>{moduleFields}</details> : moduleFields
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
          <Button type="submit" disabled={submitting || !model || moduleBlockers.length > 0}>{submitting ? t('common.saving') : mode === 'defaults' ? t('workspaceFlow.saveDefaults') : mode === 'confirmation' ? t('workspaceFlow.confirmActivate') : t('workspaceFlow.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
