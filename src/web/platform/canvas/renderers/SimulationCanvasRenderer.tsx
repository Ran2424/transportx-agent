import { SimulationWorkspace } from '../../../features/simulation/SimulationWorkspace';
import { parseSimulationCanvasPayload } from '../../../../contracts/simulation';
import type { CanvasRendererProps } from './types';

export default function SimulationCanvasRenderer(props: CanvasRendererProps) {
  const payload = parseSimulationCanvasPayload(props.view.canvas?.payload);
  return props.view.kind === 'simulation' && payload ? <SimulationWorkspace {...props} payload={payload} /> : null;
}
