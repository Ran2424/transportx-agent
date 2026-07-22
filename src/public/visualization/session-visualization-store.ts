import type { VisualizationEnvelope } from '../../contracts/geo.ts';

export class SessionVisualizationStore {
  private sessions = new Map<string, Map<string, VisualizationEnvelope>>();

  reset(sessionKey: string) {
    this.sessions.set(sessionKey, new Map());
  }

  accept(sessionKey: string, envelope: VisualizationEnvelope) {
    let visualizations = this.sessions.get(sessionKey);
    if (!visualizations) {
      visualizations = new Map();
      this.sessions.set(sessionKey, visualizations);
    }
    const current = visualizations.get(envelope.visualizationId);
    if (current && current.revision >= envelope.revision) return false;
    visualizations.set(envelope.visualizationId, envelope);
    return true;
  }

  list(sessionKey: string) {
    return Array.from(this.sessions.get(sessionKey)?.values() || [])
      .filter((envelope) => envelope.scene !== null)
      .sort((a, b) => b.revision - a.revision || b.generatedAt.localeCompare(a.generatedAt));
  }

  get(sessionKey: string, visualizationId: string) {
    const envelope = this.sessions.get(sessionKey)?.get(visualizationId);
    return envelope?.scene ? envelope : null;
  }
}
