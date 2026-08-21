import type { ComponentType } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import { GeoWorkspace } from '../../features/geo/GeoWorkspace';
import { VideoWorkspace } from '../../features/video/VideoWorkspace';
import type { CanvasItemKind } from './canvas-state';

type CanvasRendererProps = { session: LiveSession | null; active: boolean };

export const canvasRenderers: Record<CanvasItemKind, ComponentType<CanvasRendererProps>> = {
  geo: GeoWorkspace,
  video: VideoWorkspace,
};
