import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CountBatch, CountComparisonRequest, CountComparisonResult } from '../../../contracts/count-comparison.ts';
import type { CountComparisonCommands } from '../../../public/kernel/commands.ts';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { CountComparisonChart, formatHour } from './CountComparisonChart';
import { downloadCountComparison } from './count-export';

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => index);
const SEATTLE_CATALOG = 'https://data.seattle.gov/Transportation/Fremont-Bridge-Combined-Bicycle-and-Scooter-Counte/65db-xm6k';
const DEFAULT_FILTER: CountComparisonRequest = { batchA: '', batchB: '', startHour: 7, endHour: 19 };
const messageOf = (cause: unknown) => (cause as { message?: string } | null)?.message || '';

function CountComparisonContent({ result }: { result: CountComparisonResult }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const totals = ([0, 1] as const).map(index => result.rows.reduce((sum, row) => ({
    valid: sum.valid + row.values[index].valid, total: sum.total + row.values[index].total,
  }), { valid: 0, total: 0 }));
  return (
    <div className="count-comparison-results" data-testid="count-comparison-results">
      <div className="count-summary-grid">
        {result.batches.map((batch, index) => (
          <div className={'count-summary count-series-' + (index === 0 ? 'a' : 'b')} key={batch.id}>
            <span className="count-marker" aria-hidden="true">{index === 0 ? 'A' : 'B'}</span>
            <div><strong>{batch.label}</strong><span>{t('counts.summarySamples', totals[index])}</span></div>
          </div>
        ))}
      </div>
      <CountComparisonChart key={result.runId} result={result} />
      <section aria-labelledby="count-details-heading">
        <div className="count-results-heading">
          <h3 id="count-details-heading">{t('counts.results')}</h3>
          <div className="count-exports">
            <Button type="button" variant="outline" onClick={() => downloadCountComparison(result, 'csv')}>{t('counts.exportCsv')}</Button>
            <Button type="button" variant="outline" onClick={() => downloadCountComparison(result, 'json')}>{t('counts.exportJson')}</Button>
          </div>
        </div>
        <div className="count-table-scroll">
          <table className="count-table">
            <thead>
              <tr><th rowSpan={2} scope="col">{t('counts.hour')}</th><th colSpan={2} scope="colgroup" className="count-series-a">A</th><th colSpan={2} scope="colgroup" className="count-series-b">B</th></tr>
              <tr><th scope="col">{t('counts.average')}</th><th scope="col">{t('counts.samples')}</th><th scope="col">{t('counts.average')}</th><th scope="col">{t('counts.samples')}</th></tr>
            </thead>
            <tbody>
              {result.rows.map(row => <tr key={row.hour}>
                <th scope="row">{formatHour(row.hour)}</th>
                {row.values.map((bucket, index) => (
                  <CountBucketCells key={index} average={bucket.average} valid={bucket.valid} total={bucket.total} number={number} />
                ))}
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>
      <details className="count-provenance">
        <summary>{t('counts.provenance')}</summary>
        <dl>
          <div><dt>{t('counts.run')}</dt><dd><code>{result.runId}</code></dd></div>
          <div><dt>{t('counts.analysisEngine')}</dt><dd>DuckDB {result.engineVersion.replace(/^v/, '')}</dd></div>
          <div><dt>{t('counts.method')}</dt><dd><code>{result.methodVersion}</code></dd></div>
          {result.batches.map((batch, index) => (
            <div key={batch.id}>
              <dt>{t(index === 0 ? 'counts.batchA' : 'counts.batchB')}</dt>
              <dd>
                <span>{t('counts.batchDetails', { start: batch.startDate, end: batch.endDateExclusive })}</span>
                <a href={batch.sourceUrl} target="_blank" rel="noreferrer">{t('counts.sourceRequest')}</a>
                <code>SHA-256 {batch.sha256}</code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function CountBucketCells({ average, valid, total, number }: { average: number | null; valid: number; total: number; number: Intl.NumberFormat }) {
  const { t } = useTranslation();
  return <>
    <td>{average === null ? <span aria-label={t('counts.missing')}>—</span> : number.format(average)}</td>
    <td>{t('counts.totalSamples', { valid, total })}</td>
  </>;
}

export function CountComparisonDialog({ commands, onClose }: { commands: CountComparisonCommands; onClose(): void }) {
  const { t } = useTranslation();
  const [batches, setBatches] = useState<CountBatch[]>([]);
  const [filter, setFilter] = useState<CountComparisonRequest>(DEFAULT_FILTER);
  const [result, setResult] = useState<CountComparisonResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const analysis = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    commands.list(controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setBatches(data.batches);
      setFilter({ ...DEFAULT_FILTER, batchA: data.batches[0]?.id ?? '', batchB: data.batches[1]?.id ?? '' });
    }).catch(cause => {
      if (!controller.signal.aborted) setError(messageOf(cause) || t('counts.loadError'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [commands, reload, t]);
  useEffect(() => () => analysis.current?.abort(), []);

  function update<K extends keyof CountComparisonRequest>(key: K, value: CountComparisonRequest[K]) {
    setFilter(current => ({ ...current, [key]: value }));
    setResult(null);
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (analysis.current || !filter.batchA || !filter.batchB || filter.batchA === filter.batchB || filter.startHour > filter.endHour) return;
    const controller = new AbortController();
    analysis.current = controller;
    setPending(true);
    setResult(null);
    setError('');
    try {
      const next = await commands.compare(filter, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(messageOf(cause) || t('counts.analysisError'));
    } finally {
      analysis.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const same = filter.batchA && filter.batchA === filter.batchB;
  const range = filter.startHour > filter.endHour;
  const available = batches.length >= 2;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }} title={t('counts.title')} className="count-comparison-dialog">
      <div className="count-source">
        <strong>{t('counts.source')}</strong>
        <a href={SEATTLE_CATALOG} target="_blank" rel="noreferrer">{t('counts.sourceLink')}</a>
        <p>{t('counts.sourceDetail')}</p>
      </div>
      {loading ? <p role="status" className="count-empty">{t('counts.loading')}</p> : available ? (
        <form onSubmit={submit} className="count-comparison-form">
          <fieldset disabled={pending}>
            {(['batchA', 'batchB'] as const).map(key => (
              <label key={key}>{t(`counts.${key}`)}
                <select value={filter[key]} onChange={event => update(key, event.target.value)}>
                  {batches.map(batch => <option key={batch.id} value={batch.id}>{batch.label}</option>)}
                </select>
              </label>
            ))}
            {(['startHour', 'endHour'] as const).map(key => (
              <label key={key}>{t(key === 'startHour' ? 'counts.start' : 'counts.end')}
                <select value={filter[key]} onChange={event => update(key, Number(event.target.value))}>
                  {HOUR_OPTIONS.map(hour => <option key={hour} value={hour}>{formatHour(hour)}</option>)}
                </select>
              </label>
            ))}
            <Button type="submit" disabled={pending || !!same || range}>{t(pending ? 'counts.pending' : 'counts.submit')}</Button>
          </fieldset>
          {same || range ? <p className="form-error">{t(same ? 'counts.same' : 'counts.range')}</p> : null}
        </form>
      ) : !error ? <p className="count-empty">{t('counts.noBatches')}</p> : null}
      {error ? <div className="count-error" role="alert">
        <p className="form-error">{error}</p>
        {!available ? <Button variant="outline" onClick={() => { setLoading(true); setError(''); setReload(value => value + 1); }}>{t('common.retry')}</Button> : null}
      </div> : null}
      {result ? <CountComparisonContent result={result} /> : pending ? <p role="status" className="count-empty">{t('counts.pending')}</p>
        : available && !error ? <p className="count-empty">{t('counts.empty')}</p> : null}
    </Dialog>
  );
}
