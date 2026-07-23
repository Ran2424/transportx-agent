import maplibregl from 'maplibre-gl';
import type { GeoLayer, GeoVisualValue } from '../../../contracts/geo.js';

type Expression = unknown;
type LayerSpec = maplibregl.LayerSpecification;

function compile(value: GeoVisualValue | undefined, fallback: string | number | number[]): Expression {
  if (!value) return fallback;
  if (value.mode === 'constant') return value.value;
  if (value.mode === 'categorical') {
    return ['match', ['get', value.field], ...value.categories.flatMap((item) => [item.value, item.output]), value.fallback];
  }
  if (value.mode === 'step') {
    return ['step', ['to-number', ['get', value.field]], value.default, ...value.stops.flatMap((item) => [item.value, item.output])];
  }
  return ['interpolate', ['linear'], ['to-number', ['get', value.field]], ...value.stops.flatMap((item) => [item.value, item.output])];
}

function selectedColor(normal: Expression) {
  return ['case', ['boolean', ['feature-state', 'selected'], false], '#f59e0b', normal];
}

function interactiveSize(normal: Expression, hoverDelta: number, selectedDelta = hoverDelta) {
  return ['+', normal,
    ['case', ['boolean', ['feature-state', 'selected'], false], selectedDelta,
      ['boolean', ['feature-state', 'hover'], false], hoverDelta, 0],
  ];
}

function interactiveOpacity(normal: Expression) {
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], 0.72,
    ['boolean', ['feature-state', 'hover'], false], 0.62,
    normal,
  ];
}

export function geoRuntimeSourceId(sourceId: string) {
  return `tau-source-${sourceId}`;
}

export function geoRuntimeLayerId(layerId: string, suffix = '') {
  return `tau-layer-${layerId}${suffix}`;
}

function layerBase(layer: GeoLayer, id: string, sourceId: string) {
  return {
    id,
    source: sourceId,
    minzoom: layer.minZoom,
    maxzoom: layer.maxZoom,
    layout: { visibility: layer.visible === false ? 'none' : 'visible' },
  };
}

export function compileGeoLayer(layer: GeoLayer, sourceId: string, darkBasemap: boolean): { specs: LayerSpec[]; interactiveId: string } {
  const id = geoRuntimeLayerId(layer.id);
  const base = layerBase(layer, id, sourceId);
  if (layer.type === 'circle') {
    const radius = compile(layer.encoding.radius, 6);
    const color = compile(layer.encoding.color, '#2563eb');
    return {
      interactiveId: id,
      specs: [
        {
          ...base,
          id: geoRuntimeLayerId(layer.id, '-halo'),
          type: 'circle',
          paint: {
            'circle-color': selectedColor(color),
            'circle-radius': interactiveSize(radius, 4, 5),
            'circle-opacity': 0.2,
            'circle-blur': 0.55,
          },
        } as LayerSpec,
        {
          ...base,
          type: 'circle',
          paint: {
            'circle-color': selectedColor(color),
            'circle-radius': interactiveSize(radius, 1.5, 2),
            'circle-opacity': compile(layer.encoding.opacity, 0.96),
            'circle-stroke-color': compile(layer.encoding.strokeColor, darkBasemap ? '#0f172a' : '#ffffff'),
            'circle-stroke-width': interactiveSize(compile(layer.encoding.strokeWidth, 2), 0.8, 1),
          },
        } as LayerSpec,
      ],
    };
  }
  if (layer.type === 'line') {
    const width = compile(layer.encoding.width, 3.5);
    const layout = { visibility: layer.visible === false ? 'none' : 'visible', 'line-cap': 'round', 'line-join': 'round' } as const;
    return {
      interactiveId: id,
      specs: [
        {
          ...base,
          id: geoRuntimeLayerId(layer.id, '-casing'),
          type: 'line',
          layout,
          paint: {
            'line-color': darkBasemap ? '#111827' : '#ffffff',
            'line-width': ['+', width, 3.2],
            'line-opacity': 0.9,
          },
        } as LayerSpec,
        {
          ...base,
          type: 'line',
          layout,
          paint: {
            'line-color': selectedColor(compile(layer.encoding.color, '#2563eb')),
            'line-width': interactiveSize(width, 1.2, 1.8),
            'line-opacity': compile(layer.encoding.opacity, 0.94),
            'line-blur': 0.1,
            ...(layer.encoding.dash ? { 'line-dasharray': compile(layer.encoding.dash, [2, 1]) } : {}),
          },
        } as LayerSpec,
      ],
    };
  }
  if (layer.type === 'fill') return {
    interactiveId: id,
    specs: [{
      ...base,
      type: 'fill',
      paint: {
        'fill-color': selectedColor(compile(layer.encoding.color, '#60a5fa')),
        'fill-opacity': interactiveOpacity(compile(layer.encoding.opacity, 0.5)),
        'fill-outline-color': compile(layer.encoding.outlineColor, '#ffffff'),
      },
    } as LayerSpec],
  };
  const textValue = layer.encoding.textField;
  const textField = textValue?.mode === 'constant' && typeof textValue.value === 'string'
    ? ['coalesce', ['to-string', ['get', textValue.value]], textValue.value]
    : compile(textValue, '');
  return {
    interactiveId: id,
    specs: [{
      ...base,
      type: 'symbol',
      layout: {
        ...base.layout as object,
        'text-field': textField,
        'text-size': compile(layer.encoding.size, 12),
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.85,
        'text-justify': 'auto',
        'text-padding': 3,
        'text-max-width': 12,
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': selectedColor(compile(layer.encoding.color, darkBasemap ? '#f8fafc' : '#172033')),
        'text-halo-color': compile(layer.encoding.haloColor, darkBasemap ? '#111827' : '#ffffff'),
        'text-halo-width': compile(layer.encoding.haloWidth, 1.6),
        'text-halo-blur': 0.25,
      },
    } as unknown as LayerSpec],
  };
}
