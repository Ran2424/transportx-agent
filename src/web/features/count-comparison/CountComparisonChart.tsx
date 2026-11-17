import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CountComparisonResult } from '../../../contracts/count-comparison.ts';

const LEFT = 51;
const RIGHT = 19;
const TOP = 16;
const BOTTOM = 32;
const SERIES = [0, 1] as const;

export function formatHour(hour: number) {
  return String(hour).padStart(2, '0') + ':00';
}

function chartX(index: number, count: number, width: number) {
  const plot = Math.max(1, width - LEFT - RIGHT);
  return LEFT + plot * (count === 1 ? 0.5 : index / (count - 1));
}

function draw(canvas: HTMLCanvasElement, result: CountComparisonResult, active: number | null, locale: string) {
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const colors = [color('--selection-fg'), color('--status-info')];
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const maximum = Math.max(1, ...result.rows.flatMap(row => row.values.map(value => value.average ?? 0)));
  const place = Math.pow(10, Math.floor(Math.log10(maximum / 4)));
  const step = Math.ceil(maximum / (4 * place)) * place;
  const y = (value: number) => height - BOTTOM - value * (height - TOP - BOTTOM) / (4 * step);

  context.font = '12px ' + color('--tx-font-ui');
  context.strokeStyle = color('--border-strong');
  context.fillStyle = color('--text-secondary');
  context.lineWidth = 1;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (let grid = 0; grid <= 4; grid += 1) {
    const point = y(grid * step);
    context.beginPath();
    context.moveTo(LEFT, point);
    context.lineTo(width - RIGHT, point);
    context.stroke();
    context.fillText(format.format(grid * step), LEFT - 8, point);
  }
  context.textAlign = 'center';
  const interval = Math.max(1, Math.ceil(result.rows.length / (width < 440 ? 4 : 8)));
  result.rows.forEach((row, index) => {
    if (index === result.rows.length - 1 || index % interval === 0 && (result.rows.length - 1 - index >= interval || index === 0))
      context.fillText(formatHour(row.hour), chartX(index, result.rows.length, width), height - 14);
  });

  if (active !== null) {
    const x = chartX(active, result.rows.length, width);
    context.strokeStyle = color('--text-tertiary');
    context.beginPath();
    context.moveTo(x, TOP);
    context.lineTo(x, height - BOTTOM);
    context.stroke();
  }
  for (const index of SERIES) {
    context.strokeStyle = colors[index];
    context.fillStyle = colors[index];
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.setLineDash(index === 1 ? [7, 4] : []);
    context.beginPath();
    let continuous = false;
    result.rows.forEach((row, rowIndex) => {
      const value = row.values[index].average;
      if (value === null) {
        continuous = false;
        return;
      }
      const x = chartX(rowIndex, result.rows.length, width);
      if (continuous) context.lineTo(x, y(value));
      else context.moveTo(x, y(value));
      continuous = true;
    });
    context.stroke();
    context.setLineDash([]);
    result.rows.forEach((row, rowIndex) => {
      const value = row.values[index].average;
      if (value === null) return;
      const x = chartX(rowIndex, result.rows.length, width);
      const radius = active === rowIndex ? 4.5 : 2.75;
      context.beginPath();
      if (index === 0) context.arc(x, y(value), radius, 0, 2 * Math.PI);
      else context.rect(x - radius, y(value) - radius, radius * 2, radius * 2);
      context.fill();
    });
  }
}

export function CountComparisonChart({ result }: { result: CountComparisonResult }) {
  const { t, i18n } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => draw(canvas, result, active, i18n.language);
    const size = new ResizeObserver(render);
    const theme = new MutationObserver(render);
    size.observe(canvas);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    render();
    return () => { size.disconnect(); theme.disconnect(); };
  }, [result, active, i18n.language]);

  const point = active === null ? undefined : result.rows[active];
  const format = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  return (
    <section className="count-chart">
      <div className="count-chart-heading">
        <h3>{t('counts.chart')}</h3>
        <span>{t('counts.axis')}</span>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t('counts.chartLabel')}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left - LEFT) / Math.max(1, bounds.width - LEFT - RIGHT);
          setActive(Math.max(0, Math.min(result.rows.length - 1, Math.round(ratio * (result.rows.length - 1)))));
        }}
        onPointerLeave={() => setActive(null)}
      />
      <div className="count-chart-point">
        {point ? <>
          <strong>{formatHour(point.hour)}</strong>
          {point.values.map((bucket, index) => <span key={index} className={index === 0 ? 'count-series-a' : 'count-series-b'}>
            {index === 0 ? 'A' : 'B'} · {bucket.average === null ? t('counts.missing') : format.format(bucket.average)}
            {' · '}{t('counts.totalSamples', { valid: bucket.valid, total: bucket.total })}
          </span>)}
        </> : t('counts.gaps')}
      </div>
    </section>
  );
}
