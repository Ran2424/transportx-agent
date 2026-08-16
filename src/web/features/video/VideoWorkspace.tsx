import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import { formatVideoTimestamp, parseVideoTimestamp, type VideoSceneItemV1 } from '../../../contracts/video.js';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { FeatureEmpty } from '../task/TaskBoard';
import { projectVideoScene } from './video-projection';

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
export function VideoWorkspace({ session, active }: { session: LiveSession | null; active: boolean }) {
  const { t } = useTranslation();
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const entries = session ? conversation.bySession[session.id]?.snapshotEntries : undefined;
  const executions = session ? tools.bySession[session.id] : undefined;
  const scene = useMemo(
    () => projectVideoScene(entries ?? [], Object.values(executions ?? {})),
    [entries, executions],
  );
  const items = scene?.scene.videos ?? [];
  const activeItem = items.find((item) => item.id === scene?.scene.activeVideoId) ?? items.at(-1) ?? null;
  const compareItem = scene?.scene.compareVideoId ? items.find((item) => item.id === scene.scene.compareVideoId) ?? null : null;
  const [selectedId, setSelectedId] = useState('');
  const [dismissedCompareKey, setDismissedCompareKey] = useState('');
  const selected = items.find((item) => item.id === selectedId) ?? activeItem;
  useEffect(() => {
    if (activeItem && activeItem.id !== selectedId) setSelectedId(activeItem.id);
  }, [activeItem, selectedId]);

  if (!session) return <FeatureEmpty mark="05" title={t('task.waitingContext')} description={t('video.waitingDescription')} />;
  if (!selected) return <FeatureEmpty mark="05" title={t('video.emptyTitle')} description={t('video.emptyDescription')} />;

  const compareKey = compareItem && scene ? `${scene.revision}:${compareItem.id}` : '';
  const showCompare = !!compareItem && compareItem.id !== selected.id && compareKey !== dismissedCompareKey;

  if (showCompare && compareItem) {
    return (
      <div className="video-workspace">
        <div className="video-compare">
          <div className="video-compare-pane">
            <VideoPlayer
              key={`${session.id}:${selected.id}:${selected.initialSeekSeconds ?? 'start'}:${scene?.revision ?? 0}`}
              sessionId={session.id}
              item={selected}
              items={[]}
              active={active}
              onSelect={setSelectedId}
              compact
            />
          </div>
          <div className="video-compare-pane">
            <VideoPlayer
              key={`${session.id}:${compareItem.id}:${compareItem.initialSeekSeconds ?? 'start'}:${scene?.revision ?? 0}`}
              sessionId={session.id}
              item={compareItem}
              items={[]}
              active={active}
              onSelect={() => {}}
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
        key={`${session.id}:${selected.id}:${selected.initialSeekSeconds ?? 'start'}:${scene?.revision ?? 0}`}
        sessionId={session.id}
        item={selected}
        items={items}
        active={active}
        onSelect={setSelectedId}
      />
    </div>
  );
}

function VideoPlayer({ sessionId, item, items, active, onSelect, compact = false, trailingAction }: {
  sessionId: string;
  item: VideoSceneItemV1;
  items: VideoSceneItemV1[];
  active: boolean;
  onSelect(id: string): void;
  compact?: boolean;
  trailingAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [clock, setClock] = useState('');

  const recordingStart = useMemo(() => parseVideoTimestamp(item.recordingStartTime), [item.recordingStartTime]);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  const updateClock = (seconds: number) => {
    if (!recordingStart) return;
    setClock(formatVideoTimestamp(recordingStart.epochMs + seconds * 1000, recordingStart.offsetMinutes).slice(11, 19));
  };

  const src = `/api/live-sessions/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(item.resourceId)}/data`;

  return (
    <div className="video-player">
      <div className="video-toolbar">
        {items.length > 1 ? (
          <select aria-label={t('video.select')} value={item.id} onChange={(event) => onSelect(event.target.value)}>
            {items.map((video) => <option key={video.id} value={video.id}>{video.title}</option>)}
          </select>
        ) : (
          <strong className="video-toolbar-title">{item.title}</strong>
        )}
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
