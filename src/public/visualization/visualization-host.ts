import { getVisualizationFromToolResult, type GeoSceneSnapshot, type VisualizationEnvelope } from './geo/protocol.js';
import { SessionVisualizationStore } from './session-visualization-store.js';

type GeoRuntime = {
  replace(scene: GeoSceneSnapshot, sessionId: string | null): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): void;
  resize(): void;
  destroy(): void;
};

type RuntimeModule = {
  createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void): GeoRuntime;
};

type HostElements = {
  panel: HTMLElement;
  map: HTMLElement;
  empty: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  select: HTMLSelectElement;
  layers: HTMLElement;
  metadata: HTMLElement;
};

export class VisualizationHost {
  private store = new SessionVisualizationStore();
  private sessionKey: string | null = null;
  private resourceSessionId: string | null = null;
  private selectedId: string | null = null;
  private runtime: GeoRuntime | null = null;
  private runtimePromise: Promise<GeoRuntime> | null = null;
  private renderGeneration = 0;
  private resizeObserver: ResizeObserver;

  constructor(private elements: HostElements, private requestOpen: () => void) {
    this.resizeObserver = new ResizeObserver(() => this.runtime?.resize());
    this.resizeObserver.observe(elements.map);
    elements.select.addEventListener('change', () => {
      this.selectedId = elements.select.value || null;
      void this.render();
    });
  }

  setSession(sessionKey: string | null, resourceSessionId: string | null) {
    this.sessionKey = sessionKey;
    this.resourceSessionId = resourceSessionId;
    this.selectedId = sessionKey ? localStorage.getItem(`tau-visualization:${sessionKey}`) : null;
    void this.render();
  }

  resetSession(sessionKey: string) {
    this.store.reset(sessionKey);
    if (this.sessionKey === sessionKey) {
      this.selectedId = null;
      void this.render();
    }
  }

  acceptToolResult(sessionKey: string, result: unknown, autoOpen = false) {
    const envelope = getVisualizationFromToolResult(result);
    if (!envelope || !this.store.accept(sessionKey, envelope)) return null;
    if (this.sessionKey === sessionKey) {
      this.selectedId = envelope.scene ? envelope.visualizationId : null;
      if (autoOpen && envelope.scene) this.requestOpen();
      void this.render();
    }
    return envelope;
  }

  openVisualization(visualizationId: string) {
    if (!this.sessionKey || !this.store.get(this.sessionKey, visualizationId)) return;
    this.selectedId = visualizationId;
    this.requestOpen();
    void this.render();
  }

  resize() {
    this.runtime?.resize();
  }

  async render() {
    const generation = ++this.renderGeneration;
    const sessionKey = this.sessionKey;
    const resourceSessionId = this.resourceSessionId;
    const entries = sessionKey ? this.store.list(sessionKey) : [];
    document.body.classList.toggle('has-visualizations', entries.length > 0);
    this.elements.select.replaceChildren(...entries.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.visualizationId;
      option.textContent = entry.summary.title;
      return option;
    }));
    if (!entries.length || !sessionKey) {
      this.runtime?.destroy();
      this.elements.empty.classList.remove('hidden');
      this.elements.map.classList.add('hidden');
      this.elements.layers.replaceChildren();
      this.elements.metadata.replaceChildren();
      this.elements.title.textContent = 'GIS 可视化';
      this.elements.status.classList.remove('error');
      this.elements.status.textContent = '当前任务还没有地图';
      return;
    }
    let envelope = this.selectedId ? this.store.get(sessionKey, this.selectedId) : null;
    if (!envelope) envelope = entries[0];
    if (!envelope.scene) return;
    this.selectedId = envelope.visualizationId;
    this.elements.select.value = envelope.visualizationId;
    localStorage.setItem(`tau-visualization:${sessionKey}`, envelope.visualizationId);
    this.elements.empty.classList.add('hidden');
    this.elements.map.classList.remove('hidden');
    this.elements.title.textContent = envelope.scene.metadata.title;
    this.elements.status.classList.remove('error');
    const basemapLabels = { default: '城市底图', light: '浅色底图', dark: '深色底图', none: '纯色底图' };
    this.elements.status.textContent = `revision ${envelope.revision} · ${basemapLabels[envelope.scene.basemap.id]} · ${envelope.scene.layers.length} 个图层`;
    this.renderLayerControls(envelope);
    this.renderMetadata(envelope);
    try {
      const runtime = await this.getRuntime();
      if (generation !== this.renderGeneration || sessionKey !== this.sessionKey) return;
      await runtime.replace(envelope.scene, resourceSessionId);
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private renderLayerControls(envelope: VisualizationEnvelope) {
    const scene = envelope.scene!;
    const typeLabels = { circle: '点', line: '线', fill: '面', label: '注记' };
    const fragment = document.createDocumentFragment();
    const header = document.createElement('div');
    header.className = 'geo-layer-header';
    const heading = document.createElement('strong');
    heading.textContent = '地图图层';
    const count = document.createElement('span');
    count.textContent = `${scene.layers.filter((layer) => layer.visible !== false).length}/${scene.layers.length} 可见`;
    header.append(heading, count);
    fragment.appendChild(header);
    const items = document.createElement('div');
    items.className = 'geo-layer-items';
    for (const layer of [...scene.layers].reverse()) {
      const label = document.createElement('label');
      label.className = 'geo-layer-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = layer.visible !== false;
      checkbox.addEventListener('change', () => this.runtime?.setLayerVisibility(layer.id, checkbox.checked));
      const swatch = document.createElement('span');
      swatch.className = `geo-layer-swatch ${layer.type}`;
      const color = layer.encoding.color;
      if (color?.mode === 'constant' && typeof color.value === 'string') swatch.style.background = color.value;
      if (color?.mode === 'categorical') {
        const colors = color.categories.map((item) => item.output).filter((output): output is string => typeof output === 'string').slice(0, 4);
        if (colors.length > 1) swatch.style.background = `linear-gradient(90deg, ${colors.join(', ')})`;
      }
      const text = document.createElement('span');
      text.className = 'geo-layer-name';
      text.textContent = layer.title || layer.id;
      const type = document.createElement('span');
      type.className = 'geo-layer-type';
      type.textContent = typeLabels[layer.type];
      checkbox.addEventListener('change', () => {
        label.classList.toggle('is-muted', !checkbox.checked);
        count.textContent = `${items.querySelectorAll<HTMLInputElement>('input:checked').length}/${scene.layers.length} 可见`;
      });
      label.classList.toggle('is-muted', !checkbox.checked);
      label.append(checkbox, swatch, text, type);
      items.appendChild(label);
    }
    fragment.appendChild(items);
    this.elements.layers.replaceChildren(fragment);
  }

  private renderMetadata(envelope: VisualizationEnvelope) {
    const scene = envelope.scene!;
    const parts = [scene.metadata.description, ...(scene.metadata.warnings || [])].filter(Boolean) as string[];
    this.elements.metadata.replaceChildren(...parts.map((part, index) => {
      const item = document.createElement('p');
      item.className = index === 0 && scene.metadata.description ? 'geo-description' : 'geo-warning';
      item.textContent = part;
      return item;
    }));
  }

  private getRuntime() {
    if (this.runtime) return Promise.resolve(this.runtime);
    if (!this.runtimePromise) {
      this.ensureRuntimeStyles();
      const runtimeModuleUrl = '../geo-runtime.js';
      this.runtimePromise = import(runtimeModuleUrl).then((module: RuntimeModule) => {
        this.runtime = module.createGeoMapRuntime(this.elements.map, (message) => this.showError(message));
        requestAnimationFrame(() => this.runtime?.resize());
        return this.runtime;
      });
    }
    return this.runtimePromise;
  }

  private ensureRuntimeStyles() {
    if (document.querySelector('link[data-geo-runtime-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'geo-runtime.css';
    link.dataset.geoRuntimeStyle = 'true';
    document.head.appendChild(link);
  }

  private showError(message: string) {
    this.elements.status.textContent = `地图加载失败：${message}`;
    this.elements.status.classList.add('error');
  }
}
