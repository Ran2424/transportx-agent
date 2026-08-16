import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import type { VideoSceneItemV1 } from '../../../contracts/video.js';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { FeatureEmpty } from '../task/TaskBoard';
import { projectVideoScene } from './video-projection';

/**
 * Video Workspace V1: title, recording absolute time, native <video>
 * playback with initial seek, loading and error states. All business times
 * come pre-computed from the contract; React never interprets them.
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
  const [selectedId, setSelectedId] = useState('');
  const selected = items.find((item) => item.id === selectedId) ?? activeItem;
  useEffect(() => {
    if (activeItem && activeItem.id !== selectedId) setSelectedId(activeItem.id);
  }, [activeItem, selectedId]);

  if (!session) return <FeatureEmpty mark="05" title={t('task.waitingContext')} description={t('video.waitingDescription')} />;
  if (!selected) return <FeatureEmpty mark="05" title={t('video.emptyTitle')} description={t('video.emptyDescription')} />;

  return (
    <div className="video-workspace">
      {items.length > 1 ? (
        <div className="video-toolbar">
          <select aria-label={t('video.select')} value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
            {items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
      ) : null}
      <VideoPlayer
        key={`${session.id}:${selected.id}:${selected.initialSeekSeconds ?? 'start'}:${scene?.revision ?? 0}`}
        sessionId={session.id}
        item={selected}
        active={active}
      />
    </div>
  );
}

function VideoPlayer({ sessionId, item, active }: { sessionId: string; item: VideoSceneItemV1; active: boolean }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  const src = `/api/live-sessions/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(item.resourceId)}/data`;

  return (
    <div className="video-player">
      <div className="video-meta">
        <strong>{item.title}</strong>
        <small>{item.recordingStartTime} – {item.recordingEndTime}{item.kind === 'derived' ? ` · ${t('video.derivedClip')}` : ''}</small>
      </div>
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
            setLoading(false);
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
