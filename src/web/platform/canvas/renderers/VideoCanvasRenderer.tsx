import { VideoWorkspace } from '../../../features/video/VideoWorkspace';
import type { CanvasRendererProps } from './types';

export default function VideoCanvasRenderer({ session, view, active, onContextChange }: CanvasRendererProps) {
  if (view.kind !== 'video') return null;
  return <VideoWorkspace session={session} item={view.item} revision={view.revision} compareItem={view.compareItem} active={active} onContextChange={(target) => onContextChange(target)} />;
}
