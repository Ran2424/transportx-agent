import { OfficeWorkspace } from '../../../features/office/OfficeWorkspace';
import { DocumentWorkspace } from '../DocumentWorkspace';
import { isOfficeFormat } from '../document-state';
import type { CanvasRendererProps } from './types';

export default function DocumentCanvasRenderer({ view, active, documentPositions, onContextChange }: CanvasRendererProps) {
  if (view.kind !== 'document') return null;
  return isOfficeFormat(view.format)
    ? <OfficeWorkspace view={view} active={active} onContextChange={(target) => onContextChange(target)} />
    : <DocumentWorkspace view={view} active={active} positions={documentPositions} />;
}
