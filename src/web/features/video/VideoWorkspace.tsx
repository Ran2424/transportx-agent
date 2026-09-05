import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import { formatVideoTimestamp, parseVideoTimestamp, type VideoSceneItemV1 } from '../../../contracts/video.js';
import { appKernel } from '../../app/composition-root';

type VideoMetric = { id: string; label: string; unit: string; sampleIntervalSeconds: number; samples: Array<{ offsetSeconds: number; value: number }> };

function readVideoMetrics(value: unknown): VideoMetric[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { metrics?: unknown }).metrics)) return [];
  return (value as { metrics: unknown[] }).metrics.flatMap((metric) => {
    if (!metric || typeof metric !== 'object') return [];
    const { id, label, unit, sampleIntervalSeconds, samples } = metric as { id?: unknown; label?: unknown; unit?: unknown; sampleIntervalSeconds?: unknown; samples?: unknown };
    if (typeof id !== 'string' || typeof label !== 'string' || typeof unit !== 'string' || !Number.isInteger(sampleIntervalSeconds) || (sampleIntervalSeconds as number) <= 0 || !Array.isArray(samples)) return [];
    const safeSamples = samples.flatMap((sample) => {
      if (!sample || typeof sample !== 'object') return [];
      const { offsetSeconds, value: sampleValue } = sample as { offsetSeconds?: unknown; value?: unknown };
      return Number.isInteger(offsetSeconds) && (offsetSeconds as number) >= 0 && typeof sampleValue === 'number' && Number.isFinite(sampleValue)
        ? [{ offsetSeconds: offsetSeconds as number, value: sampleValue }]
        : [];
    });
    return [{ id, label, unit, sampleIntervalSeconds: sampleIntervalSeconds as number, samples: safeSamples }];
  });
}

function formatDuration(seconds: number) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Video Workspace V1: a first-class docked workspace next to the Agent
 * conversation. Native <video controls> stays untouched; the business layer
 * (camera, recording range, current absolute recording time, source/derived)
 * lives in the toolbar. Player transient state never leaves this component.
 */
export function VideoWorkspace({ session, active, item: selected, compareItem, revision }: { session: LiveSession; active: boolean; item: VideoSceneItemV1; compareItem?: VideoSceneItemV1; revision: number }) {
  const { t } = useTranslation();
  const [dismissedCompareKey, setDismissedCompareKey] = useState('');
  const compareKey = compareItem ? `${revision}:${compareItem.id}` : '';
  const showCompare = !!compareItem && compareItem.id !== selected.id && compareKey !== dismissedCompareKey;

  if (showCompare && compareItem) {
    return (
      <div className="video-workspace">
        <div className="video-compare">
          <div className="video-compare-pane">
            <VideoPlayer
              key={`${session.id}:${selected.id}:${selected.initialSeekSeconds ?? 'start'}`}
              sessionId={session.id}
              item={selected}
              active={active}
              compact
            />
          </div>
          <div className="video-compare-pane">
            <VideoPlayer
              key={`${session.id}:${compareItem.id}:${compareItem.initialSeekSeconds ?? 'start'}`}
              sessionId={session.id}
              item={compareItem}
              active={active}
              compact
              trailingAction={<button className="video-exit-compare" type="button" onClick={() => setDismissedCompareKey(compareKey)}>{t('video.exitCompare')}</button>}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="video-workspace">
      <VideoPlayer
        key={`${session.id}:${selected.id}:${selected.initialSeekSeconds ?? 'start'}`}
        sessionId={session.id}
        item={selected}
        active={active}
      />
    </div>
  );
}

function VideoPlayer({ sessionId, item, active, compact = false, trailingAction }: {
  sessionId: string;
  item: VideoSceneItemV1;
  active: boolean;
  compact?: boolean;
  trailingAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clock, setClock] = useState('');
  const [metrics, setMetrics] = useState<VideoMetric[]>([]);
  const [currentSecond, setCurrentSecond] = useState(0);

  const recordingStart = useMemo(() => parseVideoTimestamp(item.recordingStartTime), [item.recordingStartTime]);
  const metricValues = useMemo(() => metrics.flatMap((metric) => {
    const sampleSecond = Math.floor(currentSecond / metric.sampleIntervalSeconds) * metric.sampleIntervalSeconds;
    const value = metric.samples.find((sample) => sample.offsetSeconds === sampleSecond)?.value;
    return value === undefined ? [] : [{ ...metric, value }];
  }), [currentSecond, metrics]);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    setMetrics([]);
    void kernel.commands.video.getMetrics(sessionId, item.resourceId)
      .then(readVideoMetrics)
      .then((nextMetrics) => { if (!cancelled) setMetrics(nextMetrics); })
      .catch(() => { if (!cancelled) setMetrics([]); });
    return () => { cancelled = true; };
  }, [item.resourceId, kernel, sessionId]);

  const updateClock = (seconds: number) => {
    if (!recordingStart) return;
    setClock(formatVideoTimestamp(recordingStart.epochMs + seconds * 1000, recordingStart.offsetMinutes).slice(11, 19));
    setCurrentSecond(Math.floor(seconds));
  };

  const src = `/api/live-sessions/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(item.resourceId)}/data`;

  return (
    <div className="video-player">
      <div className="video-toolbar">
        <strong className="video-toolbar-title">{item.title}</strong>
        {trailingAction}
        <span className="video-toolbar-clock" title={clock ? `${item.recordingStartTime.slice(0, 10)} ${clock}` : ''}>
          {clock ? t('video.currentTime', { time: clock }) : ''}
        </span>
        <span className={`video-badge${item.kind === 'derived' ? ' is-derived' : ''}`}>
          {item.kind === 'derived' ? t('video.derivedClip') : t('video.sourceRecording')}
        </span>
      </div>
      {compact ? null : (
        <div className="video-subbar">
          <span>
            {item.cameraId ? `${t('video.camera')} ${item.cameraId} · ` : ''}
            {t('video.recording')} {item.recordingStartTime.slice(0, 10)} {item.recordingStartTime.slice(11, 19)} – {item.recordingEndTime.slice(11, 19)} · {formatDuration(item.durationSeconds)}
          </span>
        </div>
      )}
      <div className="video-stage">
        {loading && !error ? <p className="video-status" role="status">{t('video.loading')}</p> : null}
        {error ? <p className="video-status is-error" role="alert">{error}</p> : null}
        {metricValues.length ? <div className="video-metrics" aria-live="polite">{metricValues.map((metric) => <div className="video-metric" key={metric.id}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.unit}</small></div>)}</div> : null}
        <video
          ref={videoRef}
          controls
          preload="auto"
          src={src}
          aria-label={item.title}
          onLoadedMetadata={() => {
            const element = videoRef.current;
            if (element && item.initialSeekSeconds !== undefined && item.initialSeekSeconds > 0) {
              element.currentTime = Math.min(item.initialSeekSeconds, element.duration || item.initialSeekSeconds);
            }
            if (element) updateClock(element.currentTime);
            setLoading(false);
          }}
          onTimeUpdate={() => {
            const element = videoRef.current;
            if (element) updateClock(element.currentTime);
          }}
          onSeeked={() => {
            const element = videoRef.current;
            if (element) updateClock(element.currentTime);
          }}
          onError={() => {
            setLoading(false);
            setError(t('video.loadFailed'));
          }}
        />
      </div>
    </div>
  );
}
