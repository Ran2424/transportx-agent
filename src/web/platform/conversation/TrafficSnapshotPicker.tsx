import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { requestHost } from '../../app/composition-root';
import type { HttpInit } from '../../../public/kernel/command-transport.js';

type Snapshot = {
  snapshot_id: string;
  table: string;
  source_name: string;
  row_count: number;
  created_at: string;
};

async function readHost<T>(path: string, init?: HttpInit): Promise<T> {
  const response = await requestHost(path, init);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || String(response.status));
  return result;
}

export function TrafficSnapshotPicker({ sessionId, onAttach }: {
  sessionId: string;
  onAttach(path: string): void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const base = `/api/conversations/${encodeURIComponent(sessionId)}`;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError('');
    setLoading(true);
    void readHost<{ snapshots: Snapshot[] }>(base + '/traffic-snapshots', { signal: controller.signal })
      .then(({ snapshots }) => {
        if (controller.signal.aborted) return;
        setSnapshots(snapshots);
        setSnapshotId(current => snapshots.some(row => row.snapshot_id === current) ? current : '');
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, base, refresh]);

  async function attach(event: FormEvent) {
    event.preventDefault();
    if (busy || !snapshotId) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await readHost<{ path: string; snapshot: Snapshot }>(base + '/traffic-snapshots', {
        method: 'POST', body: { snapshotId },
      });
      onAttach(result.path);
      setStatus(t('conversation.snapshotAttached', { table: result.snapshot.table }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retryReceipts() {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await readHost<{ synced: number; pending: number }>(base + '/traffic-use-receipts/retry', {
        method: 'POST', body: {},
      });
      setStatus(t('conversation.trafficSyncResult', result));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <details className="traffic-snapshot-picker" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('conversation.trafficSnapshots')}</summary>
    <section aria-label={t('conversation.trafficSnapshots')}>
      {loading && <p>{t('conversation.loadingTrafficSnapshots')}</p>}
      {!loading && !error && !snapshots.length && <p>{t('conversation.noTrafficSnapshots')}</p>}
      {!!snapshots.length && <form onSubmit={attach}>
        <label htmlFor={selectId}>{t('conversation.chooseTrafficSnapshot')}</label>
        <select id={selectId} name="snapshot" required value={snapshotId} onChange={event => setSnapshotId(event.currentTarget.value)}>
          <option value="" disabled>{t('conversation.chooseTrafficSnapshot')}</option>
          {snapshots.map(snapshot => <option key={snapshot.snapshot_id} value={snapshot.snapshot_id}>
            {snapshot.table} · {snapshot.source_name} · {t('common.itemCount', { count: snapshot.row_count })} · {snapshot.created_at}
          </option>)}
        </select>
        <button type="submit" disabled={busy}>{t('conversation.attachTrafficSnapshot')}</button>
      </form>}
      <div className="traffic-picker-actions">
        <button type="button" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>{t('conversation.reloadTrafficSnapshots')}</button>
        <button type="button" disabled={busy} onClick={() => void retryReceipts()}>{t('conversation.retryTrafficReceipts')}</button>
      </div>
      <p role="status">{status}</p>
      {error && <p role="alert" className="composer-error">{error}</p>}
    </section>
  </details>;
}
