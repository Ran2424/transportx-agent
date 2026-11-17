import type { CountComparisonResult } from '../../../contracts/count-comparison.ts';
import { formatHour } from './CountComparisonChart';

function csvCell(value: string | number | null) {
  return typeof value === 'string' ? '"' + value.replace(/"/g, '""') + '"' : value ?? '';
}

export function countComparisonCsv(result: CountComparisonResult) {
  const fields = [
    'series', 'batch_id', 'batch_start', 'batch_end_exclusive', 'snapshot_sha256', 'source_url',
    'local_hour', 'valid_samples', 'published_samples', 'count_sum', 'average_per_valid_record',
    'run_id', 'engine_version', 'method_version',
  ];
  return '\ufeff' + [
    fields.join(','),
    ...result.rows.flatMap(row => result.batches.map((batch, index) => {
      const bucket = row.values[index];
      return [
        index === 0 ? 'A' : 'B', batch.id, batch.startDate, batch.endDateExclusive, batch.sha256, batch.sourceUrl,
        formatHour(row.hour), bucket.valid, bucket.total, bucket.sum, bucket.average,
        result.runId, result.engineVersion, result.methodVersion,
      ].map(csvCell).join(',');
    })),
  ].join('\r\n') + '\r\n';
}

export function downloadCountComparison(result: CountComparisonResult, format: 'csv' | 'json') {
  const blob = format === 'csv'
    ? new Blob([countComparisonCsv(result)], { type: 'text/csv;charset=utf-8' })
    : new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `fremont-counts-${result.runId.slice(0, 12)}.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
