export type PresentCommand = { command: string; visualizationId: string; [key: string]: any };

const COMMAND_REQUIRED_PARAMS: Record<string, string[]> = {
  create_map: ['title', 'resourceId', 'layerType'],
  add_layer: ['sourceId', 'layerId', 'layerType'],
  set_constant: ['layerId', 'channel', 'value'],
  set_step: ['layerId', 'channel', 'field', 'defaultValue', 'stops'],
  set_continuous: ['layerId', 'channel', 'field', 'stops'],
  set_categorical: ['layerId', 'channel', 'field', 'categories', 'fallback'],
  set_popup: ['layerId', 'fields'],
  set_camera: ['center', 'zoom'],
  fit_bounds: ['bounds'],
  set_visibility: ['layerId', 'visible'],
  remove_layer: ['layerId'],
  reorder_layers: ['layerIds'],
  select: ['sourceId', 'featureIds'],
  add_chart_layer: ['sourceId', 'layerId', 'chartType', 'valueFields'],
  set_chart: ['layerId', 'chartType', 'valueFields'],
};

export function assertCommandParams(params: PresentCommand) {
  const required = COMMAND_REQUIRED_PARAMS[params.command] || [];
  const missing = required.filter((name) => params[name] === undefined || params[name] === null || params[name] === '');
  if (missing.length) throw new Error(`Missing parameters for command ${params.command}: ${missing.join(', ')}`);
  if ((params.layerType === 'chart' || params.command === 'add_chart_layer' || params.command === 'set_chart') && params.chartType === 'bar' && !(params.maxValue > 0)) {
    throw new Error('Bar charts require a positive maxValue.');
  }
  if (params.layerType === 'chart' && (!params.chartType || !params.valueFields?.length)) {
    throw new Error('Chart layers require chartType and valueFields.');
  }
}

export function styleCommandKey(params: PresentCommand) {
  if (!['set_constant', 'set_step', 'set_continuous', 'set_categorical'].includes(params.command)) return null;
  return [params.visualizationId, params.command, params.layerId, params.channel].join('|');
}

export function styleCommandDiagnostic(params: PresentCommand) {
  if (params.command === 'set_constant') return `value=${JSON.stringify(params.value)} type=${typeof params.value}`;
  if (params.command === 'set_categorical') {
    const outputs = Array.isArray(params.categories) ? params.categories.map((item: { output?: unknown }) => `${JSON.stringify(item.output)}:${typeof item.output}`) : [];
    return `outputs=[${outputs.join(', ')}] fallback=${JSON.stringify(params.fallback)}:${typeof params.fallback}`;
  }
  const outputs = Array.isArray(params.stops) ? params.stops.map((stop: { output?: unknown }) => `${JSON.stringify(stop.output)}:${typeof stop.output}`) : [];
  return `outputs=[${outputs.join(', ')}]${params.command === 'set_step' ? ` default=${JSON.stringify(params.defaultValue)}:${typeof params.defaultValue}` : ''}`;
}
