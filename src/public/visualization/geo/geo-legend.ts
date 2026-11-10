import type { GeoLayer, GeoVisualValue } from '../../../contracts/geo.js';

export type GeoLegendSymbol = {
  type: GeoLayer['type'];
  values: Record<string, string | number | number[]>;
  dark: boolean;
  chart?: GeoLayer['chart'];
  sampleScale?: { channel: string; factor: number };
  colorStops?: Array<{ offset: number; color: string }>;
};
export type GeoLegendSection = {
  title: string;
  field?: string;
  fieldTitle?: string;
  channel?: string;
  channelTitle?: string;
  mode?: GeoVisualValue['mode'];
  entries: Array<{ label: string; symbol: GeoLegendSymbol }>;
  ramp?: Array<{ offset: number; color: string; label: string }>;
  note?: string;
};

/** Reading order is independent of titles and business domains. */
export function geoLegendItems(layers: GeoLayer[], dark: boolean, language = 'zh') {
  return layers.map((layer) => ({ layer, ...buildGeoLegend(layer, dark, language) }))
    .filter((item) => item.layer.type !== 'label' || item.sections.length > 0)
    .sort((left, right) => Number(left.sections.length > 0) - Number(right.sections.length > 0));
}

export function geoLegendCaption(section: GeoLegendSection, language = 'zh') {
  if (!section.channelTitle) return '';
  const en = language.startsWith('en');
  const mode = section.mode === 'step' ? (en ? 'classified' : '分级')
    : section.mode === 'categorical' ? (en ? 'categories' : '分类')
      : section.mode === 'continuous' && !section.ramp ? (en ? 'continuous' : '连续') : '';
  return section.channelTitle + (mode ? ` · ${mode}` : '');
}

function mappedValue(value: GeoVisualValue, input: string | number | boolean): string | number | number[] | undefined {
  if (value.mode === 'constant') return value.value;
  if (value.mode === 'categorical') return value.categories.find((item) => item.value === input)?.output ?? value.fallback;
  if (typeof input !== 'number') return undefined;
  if (value.mode === 'step') {
    let output = value.default;
    for (const stop of value.stops) if (input >= stop.value) output = stop.output;
    return output;
  }
  const first = value.stops[0], last = value.stops[value.stops.length - 1];
  if (input <= first.value) return first.output;
  if (input >= last.value) return last.output;
  const index = value.stops.findIndex((stop) => stop.value > input);
  const left = value.stops[index - 1], right = value.stops[index];
  const fraction = (input - left.value) / (right.value - left.value);
  if (typeof left.output === 'number' && typeof right.output === 'number') return left.output + (right.output - left.output) * fraction;
  const rgba = (color: string) => {
    let hex = color.slice(1);
    if (hex.length <= 4) hex = [...hex].map((character) => character + character).join('');
    if (hex.length === 6) hex += 'ff';
    return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  };
  const from = rgba(String(left.output)), to = rgba(String(right.output));
  return '#' + from.map((component, channel) => Math.round(component + (to[channel] - component) * fraction).toString(16).padStart(2, '0')).join('');
}

export function geoLegendGroups(sections: GeoLegendSection[]) {
  const groups = new Map<string, { title: string; sections: GeoLegendSection[] }>();
  for (const section of sections) {
    const key = section.field ?? section.title;
    const group = groups.get(key) ?? { title: section.fieldTitle || section.title, sections: [] };
    group.sections.push(section);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function formatGeoLegendNumber(value: number, language: string) {
  if (language.startsWith('en')) return Math.abs(value) >= 1000 && value % 1000 === 0 ? `${value / 1000}k` : String(value);
  if (Math.abs(value) >= 1e8 && value % 1e7 === 0) return `${value / 1e8}亿`;
  return Math.abs(value) >= 10000 && value % 1000 === 0 ? `${value / 10000}万` : String(value);
}

// Shared with the map compiler so an omitted encoding has the same legend.
export function geoLayerDefaults(type: GeoLayer['type'], dark: boolean): GeoLegendSymbol['values'] {
  return {
    color: type === 'fill' ? '#60a5fa' : type === 'label' ? (dark ? '#f8fafc' : '#172033') : '#2563eb',
    opacity: type === 'fill' ? 0.5 : type === 'line' ? 0.94 : 0.96,
    radius: 6, width: 3.5, size: 12,
    strokeColor: dark ? '#0f172a' : '#ffffff', strokeWidth: 2,
    outlineColor: '#ffffff', haloColor: dark ? '#111827' : '#ffffff', haloWidth: 1.6,
  };
}

function representative(value: GeoVisualValue) {
  if (value.mode === 'constant') return value.value;
  if (value.mode === 'categorical') return value.categories[0]?.output ?? value.fallback;
  return value.mode === 'step' ? value.default : value.stops[0].output;
}

export function buildGeoLegend(layer: GeoLayer, dark: boolean, language = 'zh') {
  const en = language.startsWith('en');
  const channelNames: Record<string, string> = en
    ? { color: 'Color', radius: 'Size', width: 'Width', opacity: 'Opacity', strokeColor: 'Stroke', strokeWidth: 'Stroke width', outlineColor: 'Outline', size: 'Text size', haloColor: 'Halo', haloWidth: 'Halo width' }
    : { color: '颜色', radius: '点大小', width: '线宽', opacity: '透明度', strokeColor: '描边颜色', strokeWidth: '描边宽度', outlineColor: '边界颜色', size: '字号', haloColor: '文字光晕', haloWidth: '光晕宽度' };
  const values = geoLayerDefaults(layer.type, dark);
  for (const [channel, value] of Object.entries(layer.encoding)) values[channel] = representative(value);
  const symbol: GeoLegendSymbol = { type: layer.type, values, dark, chart: layer.chart };
  const sections: GeoLegendSection[] = [];
  const number = (value: number) => formatGeoLegendNumber(value, language);
  const fieldLabel = (field: string) => layer.popup?.fields.find((item) => item.field === field)?.label || field;
  for (const [channel, value] of Object.entries(layer.encoding)) {
    if (value.mode === 'constant' || !channelNames[channel]) continue;
    const section: GeoLegendSection = { title: `${fieldLabel(value.field)} · ${channelNames[channel]}`, field: value.field, fieldTitle: fieldLabel(value.field), channel, channelTitle: channelNames[channel], mode: value.mode, entries: [] };
    const entry = (label: string, output: string | number, input?: string | number | boolean) => {
      const sample = { ...values, [channel]: output };
      if (input !== undefined) for (const [other, encoding] of Object.entries(layer.encoding)) {
        if (other === channel || other === 'textField' || encoding.mode === 'constant' || encoding.field !== value.field) continue;
        const mapped = mappedValue(encoding, input);
        if (mapped !== undefined) sample[other] = mapped;
      }
      return { label, symbol: { ...symbol, values: sample } };
    };
    if (value.mode === 'categorical') {
      section.entries = value.categories.map((item) => entry(String(item.value), item.output, item.value));
      section.entries.push(entry(en ? 'Other / unmatched' : '其他／未匹配', value.fallback));
    } else if (value.mode === 'step') {
      section.entries = [entry(`< ${number(value.stops[0].value)}`, value.default), ...value.stops.map((stop, index) => entry(
        index === value.stops.length - 1 ? `≥ ${number(stop.value)}` : `${number(stop.value)} – < ${number(value.stops[index + 1].value)}`, stop.output,
      ))];
    } else {
      const first = value.stops[0].value;
      const last = value.stops[value.stops.length - 1].value;
      if (channel.toLowerCase().includes('color')) {
        section.ramp = value.stops.map((stop) => ({ offset: (stop.value - first) / (last - first), color: String(stop.output), label: number(stop.value) }));
      } else {
        section.entries = value.stops.map((stop) => entry(number(stop.value), stop.output, stop.value));
      }
      section.note = en ? 'Continuous; values outside the range use endpoint styles' : '连续变化；范围外沿用端点样式';
    }
    const sampleLimits: Record<string, number> = { radius: 11, width: 16, size: 24, strokeWidth: 5, haloWidth: 5 };
    const sizeChannel = sampleLimits[channel] ? channel : layer.type === 'circle' ? 'radius' : layer.type === 'line' ? 'width' : 'size';
    if (sampleLimits[sizeChannel] && section.entries.length) {
      const max = Math.max(...section.entries.map((item) => Number(item.symbol.values[sizeChannel])));
      if (max > sampleLimits[sizeChannel]) {
        section.entries.forEach((item) => { item.symbol.sampleScale = { channel: sizeChannel, factor: sampleLimits[sizeChannel] / max }; });
      }
    }
    sections.push(section);
  }
  if (layer.chart) {
    const chart = layer.chart;
    sections.push({
      title: chart.type === 'bar' ? (en ? 'Value' : '数值') : (en ? 'Composition' : '构成'),
      entries: chart.valueFields.map((field, index) => ({
        label: fieldLabel(field), symbol: { ...symbol, type: 'fill', chart: undefined, values: { ...values, color: chart.colors[index] || chart.colors[0], opacity: 1 } },
      })),
      note: chart.type === 'bar' ? `${en ? 'Height range' : '柱高范围'}: 0 – ${chart.maxValue}`
        : chart.type === 'donut' && chart.valueFields.length === 1 ? (en ? 'Share: 0–100%' : '占比：0–100%')
          : (en ? 'Each component as a share of the total' : '各组成项占总量的比例'),
    });
  }
  const color = layer.encoding.color;
  if (color && color.mode !== 'constant') {
    if (color.mode === 'continuous') {
      const first = color.stops[0].value, last = color.stops[color.stops.length - 1].value;
      symbol.colorStops = color.stops.map((stop) => ({ offset: (stop.value - first) / (last - first), color: String(stop.output) }));
    } else {
      const colors = color.mode === 'categorical' ? [...color.categories.map((item) => item.output), color.fallback] : [color.default, ...color.stops.map((stop) => stop.output)];
      symbol.colorStops = colors.flatMap((output, index) => [{ offset: index / colors.length, color: String(output) }, { offset: (index + 1) / colors.length, color: String(output) }]);
    }
  }
  return { symbol, sections };
}

/** A symbol sample, not a map feature; large sizes are scaled to fit the key. */
export function drawGeoLegendSymbol(ctx: CanvasRenderingContext2D, symbol: GeoLegendSymbol, x: number, y: number, width = 40, height = 28, background = symbol.dark ? '#17202b' : '#f4f6f8') {
  const v = symbol.values;
  const size = (channel: string) => Number(v[channel]) * (symbol.sampleScale?.channel === channel ? symbol.sampleScale.factor : 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = String(v.color);
  ctx.strokeStyle = String(v.color);
  if (symbol.colorStops) {
    const gradient = ctx.createLinearGradient(4, 0, width - 4, 0);
    symbol.colorStops.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));
    ctx.fillStyle = gradient; ctx.strokeStyle = gradient;
  }
  ctx.globalAlpha = Number(v.opacity);
  const cx = width / 2, cy = height / 2;
  if (symbol.type === 'line') {
    ctx.lineWidth = Math.min(height - 6, size('width'));
    ctx.lineCap = 'round';
    if (size('width') > 0) {
      if (Array.isArray(v.dash)) ctx.setLineDash(v.dash.map((value) => value * ctx.lineWidth));
      ctx.beginPath(); ctx.moveTo(4, cy); ctx.lineTo(width - 4, cy); ctx.stroke();
    }
  } else if (symbol.type === 'circle') {
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(0, Math.min(height / 2 - 3, size('radius'))), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = String(v.strokeColor);
    ctx.lineWidth = Math.min(5, size('strokeWidth'));
    if (ctx.lineWidth > 0 && Number(v.strokeWidth) > 0) ctx.stroke();
  } else if (symbol.type === 'label') {
    ctx.globalAlpha = 1;
    ctx.font = `${Math.max(8, Math.min(height - 4, size('size')))}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = String(v.haloColor); ctx.lineWidth = size('haloWidth') * 2;
    if (Number(v.haloWidth) > 0) ctx.strokeText('Aa', cx, cy);
    ctx.fillText('Aa', cx, cy);
  } else if (symbol.type === 'chart' && symbol.chart) {
    ctx.globalAlpha = 1;
    const chart = symbol.chart;
    if (chart.type === 'bar') {
      ctx.fillStyle = chart.trackColor || '#e5e7eb'; ctx.fillRect(cx - 5, 3, 10, height - 6);
      ctx.fillStyle = chart.colors[0]; ctx.fillRect(cx - 5, cy, 10, height / 2 - 3);
    } else {
      const colors = chart.type === 'donut' && chart.valueFields.length === 1 ? [chart.colors[0], chart.trackColor || '#e5e7eb'] : chart.colors;
      colors.forEach((color, index) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, height / 2 - 3, -Math.PI / 2 + index * Math.PI * 2 / colors.length, -Math.PI / 2 + (index + 1) * Math.PI * 2 / colors.length);
        ctx.closePath(); ctx.fill();
      });
      if (chart.type === 'donut') {
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, (height / 2 - 3) * 0.54, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else {
    ctx.fillRect(5, 5, width - 10, height - 10);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = String(v.outlineColor); ctx.lineWidth = 1; ctx.strokeRect(5, 5, width - 10, height - 10);
  }
  ctx.restore();
}

export function drawGeoLegendRamp(ctx: CanvasRenderingContext2D, ramp: NonNullable<GeoLegendSection['ramp']>, x: number, y: number, width: number, height: number) {
  const gradient = ctx.createLinearGradient(x, y, x + width, y);
  ramp.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, width, height);
}
