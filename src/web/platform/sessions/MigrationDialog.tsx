import { useEffect, useRef, useState } from 'react';
import type { WorkspaceMigrationStateV1, WorkspaceMigrationItemV1 } from '../../../contracts/workspace-migration.js';
import type { WorkspaceView } from '../../../public/app-types.js';
import { appKernel, refreshHostHealth } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

type Report = { item: WorkspaceMigrationItemV1; reportDigest: string; sources: unknown[]; observations: unknown[]; reportError: string | null; prepared: null | { sourceDigest: string; notes: unknown[]; issues: Array<{ sourceId: string; file: string; key: string; reason: string; candidates: string[] }> } };
type Status = { dataState: string; inventory: WorkspaceMigrationStateV1 | null; [key: string]: unknown };
type Runtime = { generation: string | null; phase: string; conversationId?: string; logDirectory?: string; processes: unknown[]; [key: string]: unknown };
export function MigrationDialog({ open, onOpenChange, workspace }: { open: boolean; onOpenChange(open: boolean): void; workspace: WorkspaceView | null }) {
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
    if (!report || !window.confirm(`${action === 'isolate' ? '隔离此源并保留原文件' : action === 'reprepare' ? '按当前源重新准备迁移' : '重试此源'}？\n${report.item.path}\n将校验当前报告和版本。`)) return;
    const body = { itemId: report.item.id, expectedRevision: report.item.revision, reportDigest: report.reportDigest, action };
    void execute('/api/migration/resolve', { ...body, requestId: requestId(body) });
  }
  function resolvePrivate(sourceId: string, action: 'bind' | 'isolate', conversationId: string | null) {
    if (!report?.prepared || !report.item.workspaceId || !window.confirm(action === 'isolate' ? '隔离此私有状态关联？原件和备份会保留。' : '将此关联绑定到唯一有完整证据的会话？')) return;
    const body = { sourceId, action, conversationId, expectedRevision: report.item.revision, reportDigest: report.prepared.sourceDigest };
    void execute(`/api/workspaces/${encodeURIComponent(report.item.workspaceId)}/migration/resolve`, { ...body, requestId: requestId(body) });
  }
  const items = status?.inventory?.items.filter((item) => !workspace || item.workspaceId === workspace.id || item.id === workspace.migrationItemId) || [];
  return <Dialog open={open} onOpenChange={onOpenChange} title={workspace ? `${workspace.name} · 迁移与运行诊断` : '存储迁移诊断'} className="migration-dialog" footer={<><Button variant="quiet" disabled={busy} onClick={() => void refresh().catch((cause) => setError((cause as Error).message))}>刷新</Button><Button disabled={busy} onClick={() => void execute('/api/migration/resume', {})}>重新盘点并继续</Button></>}>
    <p className="confirmation-dialog-copy">全局索引：{status?.dataState || '读取中'}。单个源处理失败时，其他已就绪工作区仍可使用。</p>
    {status && <pre>{JSON.stringify({ phase: status.phase, pending: status.pending, blocked: status.blocked, code: status.code, message: status.message, report: status.report }, null, 2)}</pre>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!status?.inventory && <p className="confirmation-dialog-copy">全局目录或迁移索引不可用时，业务写入会暂停。请从已校验的备份修复原索引，再重新盘点；此处不会清空索引重建。</p>}
    <div className="migration-source-list">{items.map((item) => <article key={item.id}><strong>{item.path}</strong><small>{item.state} · {item.stage} · revision {item.revision}</small>{item.error && <p className="form-error">{item.error.code}: {item.error.message}</p>}<Button variant="quiet" disabled={busy || status?.dataState !== 'ready'} onClick={() => void inspect(item)}>查看报告与处理选项</Button></article>)}</div>
    {report && <section className="migration-report"><h3>源报告</h3><p>{report.item.path}</p>{report.reportError && <p className="form-error">{report.reportError}</p>}<pre>{JSON.stringify({ digest: report.reportDigest, sources: report.sources, observations: report.observations, notes: report.prepared?.notes }, null, 2)}</pre>
      <div className="form-actions"><Button disabled={busy} onClick={() => resolveSource('retry')}>重试此源</Button><Button variant="outline" disabled={busy} onClick={() => resolveSource('reprepare')}>重新准备</Button><Button variant="quiet" disabled={busy} onClick={() => resolveSource('isolate')}>隔离此源</Button></div>
      {report.prepared?.issues.map((issue) => <article key={issue.sourceId}><strong>{issue.file} · {issue.key}</strong><p>{issue.reason}</p><small>候选会话：{issue.candidates.join(', ') || '无完整证据'}</small><div className="form-actions">{issue.candidates.length === 1 && <Button disabled={busy} onClick={() => resolvePrivate(issue.sourceId, 'bind', issue.candidates[0])}>绑定到唯一候选</Button>}<Button variant="quiet" disabled={busy} onClick={() => resolvePrivate(issue.sourceId, 'isolate', null)}>隔离此关联</Button></div></article>)}
    </section>}
    {runtime && workspace && <section className="migration-report"><h3>运行状态：{runtime.phase}</h3><pre>{JSON.stringify(runtime, null, 2)}</pre>{runtime.generation && <div className="form-actions"><Button disabled={busy} onClick={() => void execute(`/api/workspaces/${encodeURIComponent(workspace.id)}/runtime-recovery`, { generation: runtime.generation, action: 'recheck' })}>重新检查进程</Button><Button variant="outline" disabled={busy} onClick={() => { if (window.confirm('只停止能够证明属于该次运行的进程。身份不明的进程不会被强制解锁。继续？')) void execute(`/api/workspaces/${encodeURIComponent(workspace.id)}/runtime-recovery`, { generation: runtime.generation, action: 'stop-owned' }); }}>安全停止并重新检查</Button></div>}{runtime.conversationId && workspace.conversations.some(({ record }) => record.id === runtime.conversationId) && <Button variant="quiet" disabled={busy} onClick={async () => { if (!window.confirm('停止此会话的执行、交互和任务并关闭运行？')) return; setBusy(true); try { await appKernel.commands.session.close(runtime.conversationId!, true); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>停止并关闭此会话</Button>}</section>}
  </Dialog>;
}
