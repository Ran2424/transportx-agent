import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceMigrationStateV1, WorkspaceMigrationItemV1 } from '../../../contracts/workspace-migration.js';
import type { WorkspaceView } from '../../../public/app-types.js';
import { appKernel, refreshHostHealth } from '../../app/composition-root';
import { projectUi } from '../../app/project-ui';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

type Report = { item: WorkspaceMigrationItemV1; reportDigest: string; sources: unknown[]; observations: unknown[]; reportError: string | null; prepared: null | { sourceDigest: string; notes: unknown[]; issues: Array<{ sourceId: string; file: string; key: string; reason: string; candidates: string[] }> } };
type Status = { dataState: string; inventory: WorkspaceMigrationStateV1 | null; [key: string]: unknown };
type Runtime = { generation: string | null; phase: string; conversationId?: string; logDirectory?: string; processes: unknown[]; [key: string]: unknown };
export function MigrationDialog({ open, onOpenChange, workspace }: { open: boolean; onOpenChange(open: boolean): void; workspace: WorkspaceView | null }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null), [report, setReport] = useState<Report | null>(null), [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const requests = useRef(new Map<string, string>());
  async function refresh() {
    const value = await appKernel.commands.session.migration() as Status; setStatus(value);
    if (workspace) setRuntime(await appKernel.commands.session.migration(`/api/workspaces/${encodeURIComponent(workspace.id)}/runtime-diagnostics`) as Runtime);
    await refreshHostHealth();
    if (value.dataState === 'ready') await appKernel.commands.session.list();
  }
  useEffect(() => { if (!open) return; setReport(null); setError(''); void refresh().catch((cause) => setError((cause as Error).message)); }, [open, workspace]);
  async function execute(path: string, body: Record<string, unknown>) {
    setBusy(true); setError('');
    try { await appKernel.commands.session.migration(path, body); await refresh(); setReport(null); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function requestId(body: unknown) { const key = JSON.stringify(body), id = requests.current.get(key) || crypto.randomUUID(); requests.current.set(key, id); return id; }
  async function inspect(item: WorkspaceMigrationItemV1) {
    setBusy(true); setError('');
    try { setReport(await appKernel.commands.session.migration(`/api/migration/items/${encodeURIComponent(item.id)}`) as Report); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function resolveSource(action: 'isolate' | 'retry' | 'reprepare') {
    if (!report || !window.confirm(t('workspaceFlow.confirmSource', { action: action === 'isolate' ? t('workspaceFlow.isolateSourceIntent') : action === 'reprepare' ? t('workspaceFlow.reprepareSourceIntent') : t('workspaceFlow.retrySource'), path: report.item.path }))) return;
    const body = { itemId: report.item.id, expectedRevision: report.item.revision, reportDigest: report.reportDigest, action };
    void execute('/api/migration/resolve', { ...body, requestId: requestId(body) });
  }
  function resolvePrivate(sourceId: string, action: 'bind' | 'isolate', conversationId: string | null) {
    if (!report?.prepared || !report.item.workspaceId || !window.confirm(action === 'isolate' ? t('workspaceFlow.confirmPrivateIsolate') : t('workspaceFlow.confirmPrivateBind'))) return;
    const body = { sourceId, action, conversationId, expectedRevision: report.item.revision, reportDigest: report.prepared.sourceDigest };
    void execute(`/api/workspaces/${encodeURIComponent(report.item.workspaceId)}/migration/resolve`, { ...body, requestId: requestId(body) });
  }
  const items = status?.inventory?.items.filter((item) => !workspace || item.workspaceId === workspace.id || item.id === workspace.migrationItemId) || [];
  return <Dialog open={open} onOpenChange={onOpenChange} title={workspace ? `${workspace.name} · ${t('workspaceFlow.diagnostics')}` : t('workspaceFlow.storageDiagnostics')} className="migration-dialog" footer={<>{projectUi.nativeActions && <Button variant="quiet" disabled={busy} onClick={async () => { setBusy(true); try { await appKernel.commands.platform.openLogsDirectory(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>{t('settings.openLogs')}</Button>}<Button variant="quiet" disabled={busy} onClick={() => void refresh().catch((cause) => setError((cause as Error).message))}>{t('workspaceFlow.refresh')}</Button><Button disabled={busy} onClick={() => void execute('/api/migration/resume', {})}>{t('workspaceFlow.resumeInventory')}</Button></>}>
    <p className="confirmation-dialog-copy">{t('workspaceFlow.globalIndex')}：{status?.dataState || t('workspaceFlow.reading')}。{t('workspaceFlow.localFailureHelp')}</p>
    {status && <pre>{JSON.stringify({ phase: status.phase, pending: status.pending, blocked: status.blocked, code: status.code, message: status.message, report: status.report }, null, 2)}</pre>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!status?.inventory && <p className="confirmation-dialog-copy">{t('workspaceFlow.indexRepairHelp')}</p>}
    <div className="migration-source-list">{items.map((item) => <article key={item.id}><strong>{item.path}</strong><small>{item.state} · {item.stage} · revision {item.revision}</small>{item.error && <p className="form-error">{item.error.code}: {item.error.message}</p>}<Button variant="quiet" disabled={busy || status?.dataState !== 'ready'} onClick={() => void inspect(item)}>{t('workspaceFlow.inspectReport')}</Button></article>)}</div>
    {report && <section className="migration-report"><h3>{t('workspaceFlow.sourceReport')}</h3><p>{report.item.path}</p>{report.reportError && <p className="form-error">{report.reportError}</p>}<pre>{JSON.stringify({ digest: report.reportDigest, sources: report.sources, observations: report.observations, notes: report.prepared?.notes }, null, 2)}</pre>
      <div className="form-actions"><Button disabled={busy} onClick={() => resolveSource('retry')}>{t('workspaceFlow.retrySource')}</Button><Button variant="outline" disabled={busy} onClick={() => resolveSource('reprepare')}>{t('workspaceFlow.reprepare')}</Button><Button variant="quiet" disabled={busy} onClick={() => resolveSource('isolate')}>{t('workspaceFlow.isolateSource')}</Button></div>
      {report.prepared?.issues.map((issue) => <article key={issue.sourceId}><strong>{issue.file} · {issue.key}</strong><p>{issue.reason}</p><small>{t('workspaceFlow.privateCandidates')}：{issue.candidates.join(', ') || t('workspaceFlow.noEvidence')}</small><div className="form-actions">{issue.candidates.length === 1 && <Button disabled={busy} onClick={() => resolvePrivate(issue.sourceId, 'bind', issue.candidates[0])}>{t('workspaceFlow.bindUnique')}</Button>}<Button variant="quiet" disabled={busy} onClick={() => resolvePrivate(issue.sourceId, 'isolate', null)}>{t('workspaceFlow.isolatePrivate')}</Button></div></article>)}
    </section>}
    {runtime && workspace && <section className="migration-report"><h3>{t('workspaceFlow.runtimeState')}：{runtime.phase}</h3><pre>{JSON.stringify(runtime, null, 2)}</pre>{runtime.generation && <div className="form-actions"><Button disabled={busy} onClick={() => void execute(`/api/workspaces/${encodeURIComponent(workspace.id)}/runtime-recovery`, { generation: runtime.generation, action: 'recheck' })}>{t('workspaceFlow.recheckProcesses')}</Button><Button variant="outline" disabled={busy} onClick={() => { if (window.confirm(t('workspaceFlow.confirmStopOwned'))) void execute(`/api/workspaces/${encodeURIComponent(workspace.id)}/runtime-recovery`, { generation: runtime.generation, action: 'stop-owned' }); }}>{t('workspaceFlow.stopOwnedAndRecheck')}</Button></div>}{runtime.conversationId && workspace.conversations.some(({ record }) => record.id === runtime.conversationId) && <Button variant="quiet" disabled={busy} onClick={async () => { if (!window.confirm(t('workspaceFlow.confirmCloseRuntime'))) return; setBusy(true); try { await appKernel.commands.session.close(runtime.conversationId!, true); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>{t('workspaceFlow.stopRuntime')}</Button>}</section>}
  </Dialog>;
}
