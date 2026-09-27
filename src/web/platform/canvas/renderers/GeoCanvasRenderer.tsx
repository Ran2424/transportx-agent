import { GeoWorkspace } from '../../../features/geo/GeoWorkspace';
import type { CanvasRendererProps } from './types';

export default function GeoCanvasRenderer({ session, view, active, onContextChange }: CanvasRendererProps) {
  if (view.kind !== 'geo') return null;
  return <GeoWorkspace session={session} envelope={view.envelope} active={active} onContextChange={onContextChange} />;
}
