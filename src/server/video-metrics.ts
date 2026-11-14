import fs from 'node:fs';
import { parseVideoTimestamp, type VideoCatalogEntryV1, type VideoResourceManifestV1 } from '../contracts/index.js';
import { resolveSafeDataFile } from './video-asset-files.js';

export type VideoMetricsResult = { metrics: Array<{ id: string; label: string; unit: string; sampleIntervalSeconds: number; samples: Array<{ offsetSeconds: number; value: number }> }> };

function parseVideoMetricSamples(csvText: string, sourceStartTime: string, recordingStartTime: string, durationSeconds: number, sampleIntervalSeconds: number): Array<{ offsetSeconds: number; value: number }> {
  const sourceStart = parseVideoTimestamp(sourceStartTime);
  const recordingStart = parseVideoTimestamp(recordingStartTime);
  if (!sourceStart || !recordingStart) throw new Error('Video count source has invalid recording time metadata');
  const [header, ...rows] = csvText.trim().split(/\r?\n/);
  if (header !== 'relative_second,absolute_time,value') throw new Error('Video metric CSV has an unsupported header');
  if (rows.length > 20_000) throw new Error('Video metric CSV exceeds the supported sample limit');
  const samples: Array<{ offsetSeconds: number; value: number }> = [];
  let previousOffset = -1;
  for (const row of rows) {
    const [relativeSecond, absoluteTime, rawValue, ...extra] = row.split(',');
    const sourceOffset = Number(relativeSecond);
    const value = Number(rawValue);
    const timestamp = parseVideoTimestamp(absoluteTime);
    if (extra.length || !Number.isInteger(sourceOffset) || sourceOffset < 0 || sourceOffset % sampleIntervalSeconds !== 0 || sourceOffset <= previousOffset || !Number.isFinite(value) || !timestamp || timestamp.epochMs !== sourceStart.epochMs + sourceOffset * 1000) {
      throw new Error('Video metric CSV contains an invalid sample');
    }
    previousOffset = sourceOffset;
    const offsetSeconds = (timestamp.epochMs - recordingStart.epochMs) / 1000;
    if (offsetSeconds >= 0 && offsetSeconds <= durationSeconds) samples.push({ offsetSeconds, value });
  }
  return samples;
}

export function readVideoMetrics(record: { entry: VideoCatalogEntryV1; assetRoot: string }, manifest: VideoResourceManifestV1): VideoMetricsResult {
  const metrics = (record.entry.metrics ?? []).map((metric) => {
    const metricPath = resolveSafeDataFile(record.assetRoot, metric.file);
    const stat = fs.statSync(metricPath);
    if (stat.size > 2 * 1024 * 1024) throw new Error(`Video metric exceeds the supported size limit: ${metric.id}`);
    return {
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      sampleIntervalSeconds: metric.sampleIntervalSeconds,
      samples: parseVideoMetricSamples(fs.readFileSync(metricPath, 'utf8'), record.entry.startTime, manifest.recordingStartTime, manifest.durationSeconds, metric.sampleIntervalSeconds),
    };
  });
  return { metrics };
}
