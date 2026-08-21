import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';
import { projectVisualizations } from '../../features/geo/geo-projection';
import { projectVideoScene } from '../../features/video/video-projection';
import type { CanvasItem } from './canvas-state';

/** Projects existing Geo/Video tool-result envelopes into presentation-only Canvas items. */
export function projectCanvasItems(entries: SessionEntry[], executions: ToolExecution[]): CanvasItem[] {
  const geoItems = projectVisualizations(entries, executions).map((visualization) => ({
    id: `geo:${visualization.visualizationId}`,
    kind: 'geo' as const,
    resourceId: visualization.visualizationId,
    revision: visualization.revision,
    title: visualization.summary.title,
  }));
  const video = projectVideoScene(entries, executions);
  const activeVideo = video?.scene.videos.find((item) => item.id === video.scene.activeVideoId) ?? video?.scene.videos.at(-1);
  const videoItem = video && activeVideo ? [{
    id: `video:${activeVideo.id}`,
    kind: 'video' as const,
    resourceId: activeVideo.resourceId,
    revision: video.revision,
    title: activeVideo.title,
  }] : [];
  return [...geoItems, ...videoItem].sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id));
}
