import { CadWorkspace } from '../../../features/cad/CadWorkspace';
import type { CanvasRendererProps } from './types';

export default function CadCanvasRenderer(props: CanvasRendererProps) {
  return props.view.kind === 'cad' ? <CadWorkspace {...props} /> : null;
}
