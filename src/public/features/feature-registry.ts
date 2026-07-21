import type { WorkspaceRegistration, WorkspaceView } from '../workspace/workspace-types.js';

export type FeatureSessionContext = {
  sessionKey: string | null;
  resourceSessionId: string | null;
};

export type FeatureToolResultContext = {
  sessionKey: string;
  toolName?: string;
  result: unknown;
  autoOpen: boolean;
};

export type FeatureToolResult = {
  kind: 'visualization';
  id: string;
  title: string;
  revision: number;
  layers: number;
  sources: number;
} | {
  kind: 'task';
  taskId: string;
  title: string;
  status: string;
  revision: number;
};

export interface WebFeature {
  readonly id: string;
  readonly workspaceView?: WorkspaceView;
  setSession(context: FeatureSessionContext, reset: boolean): void;
  handleToolResult(context: FeatureToolResultContext): FeatureToolResult | null;
}

export class FeatureRegistry {
  private features: WebFeature[] = [];
  private context: FeatureSessionContext = { sessionKey: null, resourceSessionId: null };
  private workspace: WorkspaceRegistration;

  constructor(workspace: WorkspaceRegistration) {
    this.workspace = workspace;
  }

  register(feature: WebFeature) {
    if (this.features.some((candidate) => candidate.id === feature.id)) throw new Error(`Duplicate feature: ${feature.id}`);
    this.features.push(feature);
    if (feature.workspaceView) this.workspace.registerView(feature.workspaceView);
  }

  get sessionContext() {
    return { ...this.context };
  }

  get sessionKey() {
    return this.context.sessionKey;
  }

  setSession(sessionKey: string | null, resourceSessionId: string | null, reset = false) {
    this.context = { sessionKey, resourceSessionId };
    for (const feature of this.features) feature.setSession(this.context, reset);
  }

  handleToolResult(context: FeatureToolResultContext) {
    for (const feature of this.features) {
      const result = feature.handleToolResult(context);
      if (result) return result;
    }
    return null;
  }
}
