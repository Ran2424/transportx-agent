import maplibregl from 'maplibre-gl';
import type { GeoChart, GeoLayer, GeoVisualValue } from '../../../contracts/geo.js';
import { geoChartImagePrefix } from './geo-chart-images.js';

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
  return ['case',
    ['boolean', ['feature-state', 'selectedForRequest'], false], '#dc2626',
    ['boolean', ['feature-state', 'selectedByUser'], false], '#2563eb',
    ['boolean', ['feature-state', 'selectedByAgent'], false], '#f59e0b',
    normal,
  ];
}

function interactiveSize(normal: Expression, hoverDelta: number, selectedDelta = hoverDelta) {
  return ['+', normal,
    ['case', ['any',
      ['boolean', ['feature-state', 'selectedForRequest'], false],
      ['boolean', ['feature-state', 'selectedByUser'], false],
      ['boolean', ['feature-state', 'selectedByAgent'], false]], selectedDelta,
      ['boolean', ['feature-state', 'hovered'], false], hoverDelta, 0],
  ];
}

function interactiveOpacity(normal: Expression) {
  return ['case',
    ['any', ['boolean', ['feature-state', 'selectedForRequest'], false], ['boolean', ['feature-state', 'selectedByUser'], false], ['boolean', ['feature-state', 'selectedByAgent'], false]], 0.72,
    ['boolean', ['feature-state', 'hovered'], false], 0.62,
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

function numericField(field: string): Expression {
  return ['max', 0, ['to-number', ['get', field], 0]];
}

function chartPercent(value: Expression, total: Expression): Expression {
  return ['min', 100, ['round', ['*', 100, ['/', value, ['max', 1e-12, total]]]]];
}

function chartImageExpression(layer: GeoLayer, chart: GeoChart, state: 'normal' | 'active'): Expression {
  const values = chart.valueFields.map(numericField);
  let percentages: Expression[];
  if (chart.type === 'bar') {
    percentages = [chartPercent(values[0], chart.maxValue!)];
  } else if (chart.type === 'donut' && values.length === 1) {
    percentages = [['round', ['*', 100, ['min', 1, values[0]]]]];
  } else {
    const total: Expression = ['+', ...values];
    percentages = values.map((value) => chartPercent(value, total));
  }
  return ['concat', geoChartImagePrefix(layer.id), `${state}:`, ...percentages.flatMap((value, index) => [
    ...(index ? ['_'] : []),
    ['to-string', value],
  ])];
}

function chartLabel(chart: GeoChart): Expression {
  if (!chart.labelField) return '';
  const raw: Expression = ['get', chart.labelField];
  if (chart.labelFormat === 'text') return ['to-string', raw];
  const value: Expression = ['to-number', raw, 0];
  const formatted = chart.labelFormat === 'percent'
    ? ['concat', ['number-format', ['*', 100, value], { 'max-fraction-digits': 1 }], '%']
    : ['number-format', value, { 'max-fraction-digits': chart.labelFormat === 'decimal' ? 2 : 0 }];
  // Preserve a textual field instead of silently coercing a mistaken label
  // configuration such as station_name + integer into a misleading zero.
  return ['case', ['==', ['typeof', raw], 'number'], formatted, ['to-string', raw]];
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
  if (layer.type === 'chart' && layer.chart) {
    const chart = layer.chart;
    const showAll = chart.collisionMode !== 'hide-overlap';
    return {
      interactiveId: id,
      specs: [
        {
          ...base,
          type: 'symbol',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: {
            ...base.layout as object,
            'icon-image': ['coalesce',
              ['image', chartImageExpression(layer, chart, 'normal')],
              ['image', chartImageExpression(layer, chart, 'normal')],
            ],
            'icon-size': 1,
            'icon-anchor': chart.type === 'bar' ? 'bottom' : 'center',
            'icon-allow-overlap': showAll,
            'icon-ignore-placement': showAll,
            'icon-padding': 3,
            'text-field': chartLabel(chart),
            'text-size': Math.max(10, Math.min(14, chart.size * 0.28)),
            'text-anchor': chart.type === 'bar' ? 'bottom' : 'center',
            'text-offset': chart.type === 'bar' ? [0, -chart.size / 12] : [0, 0],
            'text-optional': true,
            'text-allow-overlap': showAll,
            'text-ignore-placement': showAll,
          },
          paint: {
            'text-color': darkBasemap ? '#f8fafc' : '#172033',
            'text-halo-color': darkBasemap ? '#111827' : '#ffffff',
            'text-halo-width': 1.2,
          },
        } as unknown as LayerSpec,
        {
          ...base,
          id: geoRuntimeLayerId(layer.id, '-interaction'),
          type: 'symbol',
          filter: ['==', ['geometry-type'], 'Point'],
          layout: {
            ...base.layout as object,
            'icon-image': ['coalesce',
              ['image', chartImageExpression(layer, chart, 'active')],
              ['image', chartImageExpression(layer, chart, 'active')],
            ],
            'icon-size': 1,
            'icon-anchor': chart.type === 'bar' ? 'bottom' : 'center',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: {
            'icon-opacity': ['case',
              ['any', ['boolean', ['feature-state', 'selectedForRequest'], false], ['boolean', ['feature-state', 'selectedByUser'], false], ['boolean', ['feature-state', 'selectedByAgent'], false]], 1,
              ['boolean', ['feature-state', 'hovered'], false], 0.72,
              0,
            ],
          },
        } as unknown as LayerSpec,
      ],
    };
  }
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
