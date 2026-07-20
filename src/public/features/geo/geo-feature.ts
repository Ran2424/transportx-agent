import { VisualizationHost } from '../../visualization/visualization-host.js';
import type { WebFeature, FeatureSessionContext, FeatureToolResultContext } from '../feature-registry.js';

type GeoFeatureOptions = {
  onRequestOpen(): void;
};

export class GeoFeature implements WebFeature {
  readonly id = 'geo';
  readonly workspaceView;
  private host: VisualizationHost;

  constructor(options: GeoFeatureOptions) {
    const panel = document.getElementById('geo-panel')!;
    this.host = new VisualizationHost({
      panel,
      map: document.getElementById('geo-map')!,
      empty: document.getElementById('geo-empty')!,
      title: document.getElementById('geo-panel-title')!,
      status: document.getElementById('geo-panel-status')!,
      select: document.getElementById('geo-visualization-select') as HTMLSelectElement,
      layers: document.getElementById('geo-layer-list')!,
      metadata: document.getElementById('geo-metadata')!,
    }, options.onRequestOpen);
    this.workspaceView = {
      id: 'visualizations',
      panel,
      sidebarClass: 'visualization-mode',
      activate: () => this.host.render(),
      resize: () => this.host.resize(),
    };
    document.addEventListener('tau:open-visualization', (event) => {
      const visualizationId = (event as CustomEvent<{ visualizationId?: string }>).detail?.visualizationId;
      if (visualizationId) this.host.openVisualization(visualizationId);
    });
  }

  setSession(context: FeatureSessionContext, reset: boolean) {
    if (reset && context.sessionKey) this.host.resetSession(context.sessionKey);
    this.host.setSession(context.sessionKey, context.resourceSessionId);
  }

  handleToolResult(context: FeatureToolResultContext) {
    const envelope = this.host.acceptToolResult(context.sessionKey, context.result, context.autoOpen);
    if (!envelope?.scene) return null;
    return {
      kind: 'visualization' as const,
      id: envelope.visualizationId,
      title: envelope.summary.title,
      revision: envelope.revision,
      layers: envelope.scene.layers.length,
      sources: envelope.scene.sources.length,
    };
  }
}
