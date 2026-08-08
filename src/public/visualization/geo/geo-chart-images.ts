import type { Map as MapLibreMap, MapStyleImageMissingEvent } from 'maplibre-gl';
import type { GeoChart, GeoLayer } from '../../../contracts/geo.js';

const IMAGE_PREFIX = 'tau-chart-image-';
const PIXEL_RATIO = 2;
type ChartInteractionState = 'normal' | 'active';

export function geoChartImagePrefix(layerId: string) {
  return `${IMAGE_PREFIX}${layerId}:`;
}

export class GeoChartImageManager {
  private charts = new Map<string, GeoChart>();

  constructor(private map: MapLibreMap) {
    map.on('styleimagemissing', this.onMissing);
  }

  setLayers(layers: GeoLayer[]) {
    for (const id of this.map.listImages()) {
      if (id.startsWith(IMAGE_PREFIX)) this.map.removeImage(id);
    }
    this.charts = new Map(
      layers
        .filter((layer): layer is GeoLayer & { chart: GeoChart } => layer.type === 'chart' && !!layer.chart)
        .map((layer) => [geoChartImagePrefix(layer.id), layer.chart]),
    );
  }

  destroy() {
    this.map.off('styleimagemissing', this.onMissing);
    this.charts.clear();
  }

  private onMissing = (event: MapStyleImageMissingEvent) => {
    const entry = [...this.charts.entries()].find(([prefix]) => event.id.startsWith(prefix));
    if (!entry || this.map.hasImage(event.id)) return;
    const [rawState, rawValues] = event.id.slice(entry[0].length).split(':', 2);
    if (!['normal', 'active'].includes(rawState) || rawValues === undefined) return;
    const values = rawValues.split('_').map((value) => Number(value));
    if (!values.length || values.some((value) => !Number.isFinite(value))) return;
    this.map.addImage(event.id, drawChart(entry[1], values, rawState as ChartInteractionState), { pixelRatio: PIXEL_RATIO });
  };
}

function drawChart(chart: GeoChart, percentages: number[], state: ChartInteractionState) {
  const pixelSize = chart.size * PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = pixelSize;
  canvas.height = pixelSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  context.scale(PIXEL_RATIO, PIXEL_RATIO);
  if (chart.type === 'bar') drawBar(context, chart, percentages[0] ?? 0, state);
  else drawPie(context, chart, percentages, state);
  return context.getImageData(0, 0, pixelSize, pixelSize);
}

function drawPie(context: CanvasRenderingContext2D, chart: GeoChart, percentages: number[], state: ChartInteractionState) {
  const center = chart.size / 2;
  const radius = center - 2;
  const trackColor = chart.trackColor || '#e5e7eb';
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.arc(center, center, radius + 1, 0, Math.PI * 2);
  context.fill();

  if (chart.type === 'donut' && percentages.length === 1) {
    const lineWidth = Math.max(4, chart.size * 0.16);
    context.lineWidth = lineWidth;
    context.strokeStyle = trackColor;
    context.beginPath();
    context.arc(center, center, radius - lineWidth / 2, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = chart.colors[0];
    context.lineCap = 'round';
    context.beginPath();
    context.arc(center, center, radius - lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clampPercent(percentages[0]) / 100);
    context.stroke();
    drawCircularInteraction(context, center, radius, state);
    return;
  }

  const total = percentages.reduce((sum, value) => sum + Math.max(0, value), 0);
  let start = -Math.PI / 2;
  for (let index = 0; index < percentages.length; index++) {
    const share = total > 0 ? Math.max(0, percentages[index]) / total : 0;
    const end = start + Math.PI * 2 * share;
    context.fillStyle = chart.colors[index] || chart.colors[0];
    context.beginPath();
    context.moveTo(center, center);
    context.arc(center, center, radius, start, end);
    context.closePath();
    context.fill();
    start = end;
  }
  if (chart.type === 'donut') {
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(center, center, radius * 0.54, 0, Math.PI * 2);
    context.fill();
  }
  context.strokeStyle = '#ffffff';
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.stroke();
  drawCircularInteraction(context, center, radius, state);
}

function drawBar(context: CanvasRenderingContext2D, chart: GeoChart, percentage: number, state: ChartInteractionState) {
  const padding = 3;
  const width = Math.max(8, chart.size * 0.38);
  const left = (chart.size - width) / 2;
  const availableHeight = chart.size - padding * 2;
  const height = availableHeight * clampPercent(percentage) / 100;
  context.fillStyle = chart.trackColor || '#e5e7eb';
  context.fillRect(left, padding, width, availableHeight);
  context.fillStyle = chart.colors[0];
  context.fillRect(left, chart.size - padding - height, width, height);
  context.strokeStyle = '#ffffff';
  context.lineWidth = 2;
  context.strokeRect(left, padding, width, availableHeight);
  if (state !== 'normal') {
    context.strokeStyle = '#0f766e';
    context.lineWidth = 3;
    context.strokeRect(left - 1, padding - 1, width + 2, availableHeight + 2);
  }
}

function drawCircularInteraction(context: CanvasRenderingContext2D, center: number, radius: number, state: ChartInteractionState) {
  if (state === 'normal') return;
  context.strokeStyle = '#0f766e';
  context.lineWidth = 3;
  context.beginPath();
  context.arc(center, center, radius + 0.5, 0, Math.PI * 2);
  context.stroke();
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}
