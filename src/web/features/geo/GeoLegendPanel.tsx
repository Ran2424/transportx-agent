import { useEffect, useId, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeoLayer, GeoSceneSnapshot } from '../../../contracts/geo.js';
import { geoLegendItems, geoLegendGroups, geoLegendCaption, drawGeoLegendRamp, drawGeoLegendSymbol, type GeoLegendSection, type GeoLegendSymbol } from '../../../public/visualization/geo/geo-legend.js';
import { Icon } from '../../components/icons';

function LegendSymbol({ symbol }: { symbol: GeoLegendSymbol }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, 40, 28);
    drawGeoLegendSymbol(ctx, symbol, 0, 0, 40, 28, 'transparent');
  }, [symbol]);
  return <canvas className="geo-legend-symbol" ref={canvas} width={80} height={56} aria-hidden="true" />;
}

function LegendRamp({ ramp }: { ramp: NonNullable<GeoLegendSection['ramp']> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawGeoLegendRamp(ctx, ramp, 0, 0, 240, 14);
  }, [ramp]);
  return <div className="geo-legend-ramp"><canvas ref={canvas} width={480} height={28} aria-hidden="true" /><div className="geo-legend-ticks"><span>{ramp[0].label}</span><span>{ramp[ramp.length - 1].label}</span></div></div>;
}

function LegendItem({ item }: { item: ReturnType<typeof geoLegendItems>[number] }) {
  const { i18n } = useTranslation();
  const { layer, symbol, sections } = item;
  return <div className={`geo-legend-item${sections.length ? ' has-encoding' : ''}`} data-layer-id={layer.id}>
    <div className="geo-legend-item-title"><LegendSymbol symbol={symbol} /><span>{layer.title || layer.id}</span></div>
    {geoLegendGroups(sections).map((group, index) => <div className="geo-legend-metric" key={index}>
      {group.title !== layer.title ? <span className="geo-legend-metric-title">{group.title}</span> : null}
      {group.sections.map((section, sectionIndex) => <div className="geo-legend-section" key={sectionIndex}>
        {(!section.ramp || group.sections.length > 1) && section.channelTitle ? <span className="geo-legend-channel">{geoLegendCaption(section, i18n.language)}</span> : null}
        {section.ramp ? <LegendRamp ramp={section.ramp} /> : <div className={`geo-legend-entries${['radius', 'width', 'size'].includes(section.channel || '') ? ' is-size' : ''}`} style={{ gridTemplateColumns: `repeat(${Math.min(['radius', 'width', 'size'].includes(section.channel || '') ? 3 : 2, section.entries.length) || 1}, minmax(0, 1fr))` }}>{section.entries.map((entry, entryIndex) => <div className="geo-legend-entry" key={entryIndex}><LegendSymbol symbol={entry.symbol} /><span>{entry.label}</span></div>)}</div>}
        {!section.field && section.note ? <p>{section.note}</p> : null}
      </div>)}
    </div>)}
  </div>;
}

export function GeoLegendPanel({ scene, disabled, stageRef, onVisibility }: { scene: GeoSceneSnapshot; disabled: boolean; stageRef: RefObject<HTMLDivElement | null>; onVisibility(layerId: string, visible: boolean): void }) {
  const { t, i18n } = useTranslation();
  const [overrides, setOverrides] = useState(new Map<string, boolean>());
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState(false);
  const [open, setOpen] = useState(true);
  const [position, setPosition] = useState({ x: 12, y: 12 });
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const ignoreClick = useRef(false);
  const id = useId();
  const constrain = (x: number, y: number) => {
    const stage = stageRef.current, panel = panelRef.current;
    if (!stage || !panel || !stage.clientWidth || !stage.clientHeight) return { x, y };
    return { x: Math.max(12, Math.min(x, stage.clientWidth - panel.offsetWidth - 12)), y: Math.max(12, Math.min(y, stage.clientHeight - panel.offsetHeight - 12)) };
  };
  useEffect(() => {
    const stage = stageRef.current, panel = panelRef.current;
    if (!stage || !panel) return;
    const resize = () => {
      if (!stage.clientWidth || !stage.clientHeight) return;
      setPosition((previous) => {
        const next = constrain(previous.x, previous.y);
        return next.x === previous.x && next.y === previous.y ? previous : next;
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage); observer.observe(panel); resize();
    return () => observer.disconnect();
  }, [stageRef, scene.layers.length > 0]);
  useEffect(() => {
    const ids = new Set(scene.layers.map((layer) => layer.id));
    setOverrides((previous) => new Map([...previous].filter(([layerId]) => ids.has(layerId))));
  }, [scene.layers]);
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    ignoreClick.current = false;
    event.preventDefault(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y, moved: false };
  }
  const isVisible = (layer: GeoLayer) => overrides.get(layer.id) ?? layer.visible !== false;
  const layers = [...scene.layers].reverse();
  const visible = layers.filter(isVisible);
  const filtered = layers.filter((layer) => `${layer.title || ''} ${layer.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const items = scene.controls?.legend === false ? [] : geoLegendItems(visible, scene.basemap.id === 'dark', i18n.language);
  const showSettings = settings || scene.controls?.legend === false;
  if (!scene.layers.length) return null;
  return <section ref={panelRef} className={`geo-legend${open ? '' : ' is-collapsed'}`} aria-label={t('geo.mapLegend')} style={{ left: position.x, top: position.y }}>
    <div className="geo-legend-header">
      <button type="button" className="geo-legend-handle" aria-label={t('geo.moveDisplay')} title={t('geo.moveDisplay')} onPointerDown={startDrag} onPointerMove={(event) => { const current = drag.current; if (current?.id !== event.pointerId) return; const dx = event.clientX - current.x, dy = event.clientY - current.y; current.moved ||= Math.hypot(dx, dy) > 4; if (current.moved) setPosition(constrain(current.left + dx, current.top + dy)); }} onPointerUp={(event) => { if (drag.current?.id === event.pointerId) { ignoreClick.current = drag.current.moved; drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} onLostPointerCapture={() => { drag.current = null; }} onClick={(event) => { const ignore = event.detail && ignoreClick.current; ignoreClick.current = false; if (!ignore) setOpen(!open); }} aria-expanded={open} aria-controls={id} onKeyDown={(event) => {
        const moves: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
        if (event.key === 'Home') { event.preventDefault(); setPosition(constrain(12, 12)); }
        else if (moves[event.key]) { event.preventDefault(); const [dx, dy] = moves[event.key]; setPosition(constrain(position.x + dx, position.y + dy)); }
      }}><strong>{t(showSettings ? 'geo.layerSettings' : 'geo.mapLegend')}</strong></button>
      {open ? <button type="button" className="geo-legend-settings-button" aria-label={t('geo.layerSettings')} title={t('geo.layerSettings')} aria-pressed={showSettings} aria-controls={id} disabled={scene.controls?.legend === false} onClick={() => setSettings(!settings)}><Icon name="settings" /></button> : null}
      <button type="button" className="geo-legend-toggle" aria-expanded={open} aria-controls={id} aria-label={t(open ? 'geo.collapseDisplay' : 'geo.expandDisplay')} onClick={() => setOpen(!open)}><Icon name="chevron" /></button>
    </div>
    <div id={id} className="geo-legend-content" hidden={!open} onKeyDown={(event) => { if (event.key === 'Escape' && settings) { event.preventDefault(); event.stopPropagation(); setSettings(false); panelRef.current?.querySelector<HTMLButtonElement>('.geo-legend-settings-button')?.focus(); } }}>
      {showSettings ? <div className="geo-legend-settings">
        {layers.length > 8 || query ? <input className="geo-display-search" type="search" aria-label={t('geo.searchLayers')} placeholder={t('geo.searchLayers')} value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
        <div className="geo-legend-controls">{filtered.map((layer) => <label key={layer.id} className={`geo-legend-control${isVisible(layer) ? '' : ' is-muted'}`} data-layer-id={layer.id}><span>{layer.title || layer.id}</span><input type="checkbox" aria-label={layer.title || layer.id} checked={isVisible(layer)} disabled={disabled} onChange={(event) => { const next = event.target.checked; setOverrides((previous) => new Map(previous).set(layer.id, next)); onVisibility(layer.id, next); }} /></label>)}</div>
        {!filtered.length ? <p className="geo-legend-empty">{t('geo.noMatchingLayers')}</p> : null}
      </div> : <div className="geo-legend-reading">{items.map((item) => <LegendItem key={item.layer.id} item={item} />)}{!items.length ? <p className="geo-legend-empty">{t('geo.noLegendItems')}</p> : null}</div>}
    </div>
  </section>;
}
