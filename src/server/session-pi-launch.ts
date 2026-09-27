const fs = require('node:fs');
const path = require('node:path');

import { APP_PATHS, PI_COMMAND_ARGS, PI_AGENT_DIR, PYTHON_COMMAND, SESSIONS_DIR } from './config.js';
import { piProcessEnv } from './pi-runtime.js';
import { planExtensions, planPromptPath, planSkills, type ResolvedSessionPlan } from './session-assembly.js';
import { loadProjectPrompt, loadSystemPrompt } from './session-prompt.js';
import type { SessionService } from './session-service.js';

type SessionPiLaunchInput = {
  cwd: string;
  sessionId: string;
  sessionFile: string | null;
  modelSpec: string;
  appendSystemPrompt?: string;
  resolvedSessionPlan: ResolvedSessionPlan;
  serviceTokens: Record<SessionService, string>;
  endpoints: Record<SessionService, string>;
};

function assetDirectoryEnvironment(plan: ResolvedSessionPlan, kind: 'data' | 'knowledge', name: string) {
  const assets = plan.assets.filter((asset) => asset.kind === kind);
  return assets.length ? { [name]: JSON.stringify(Object.fromEntries(assets.map((asset) => [asset.id, asset.path]))) } : {};
}

export function buildSessionPiLaunch(input: SessionPiLaunchInput) {
  const { resolvedSessionPlan: plan } = input;
  const args = [...PI_COMMAND_ARGS, '--mode', 'rpc', '--system-prompt', loadSystemPrompt()];
  for (const extensionPath of planExtensions(plan)) {
    if (!fs.existsSync(extensionPath)) throw new Error(`Built-in extension not found: ${extensionPath}`);
    args.push('--extension', extensionPath);
  }
  for (const skillPath of planSkills(plan)) {
    if (!fs.existsSync(skillPath)) throw new Error(`Built-in skill not found: ${skillPath}`);
    args.push('--skill', skillPath);
  }
  const appendSystemPrompt = [loadProjectPrompt(input.cwd, planPromptPath(plan), plan), input.appendSystemPrompt?.trim()].filter(Boolean).join('\n\n');
  args.push('--append-system-prompt', appendSystemPrompt);
  if (input.sessionFile) args.push('--session', input.sessionFile);
  if (input.modelSpec) args.push('--model', input.modelSpec);

  return {
    args,
    env: piProcessEnv({
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
      PI_CODING_AGENT_SESSION_DIR: SESSIONS_DIR,
      TAU_DISABLED: '1',
      TAU_PYTHON_COMMAND: PYTHON_COMMAND,
      TAU_CITATION_ENDPOINT: input.endpoints.citation,
      TAU_CITATION_SESSION_ID: input.sessionId,
      TAU_CITATION_TOKEN: input.serviceTokens.citation,
      TAU_SPATIAL_ENDPOINT: input.endpoints.spatial,
      TAU_SPATIAL_SESSION_ID: input.sessionId,
      TAU_SPATIAL_TOKEN: input.serviceTokens.spatial,
      TAU_VIDEO_ENDPOINT: input.endpoints.video,
      TAU_VIDEO_SESSION_ID: input.sessionId,
      TAU_VIDEO_TOKEN: input.serviceTokens.video,
      TAU_GEO_ENDPOINT: input.endpoints.geo,
      TAU_GEO_SESSION_ID: input.sessionId,
      TAU_GEO_TOKEN: input.serviceTokens.geo,
      TAU_CANVAS_ENDPOINT: input.endpoints.canvas,
      TAU_CANVAS_SESSION_ID: input.sessionId,
      TAU_CANVAS_TOKEN: input.serviceTokens.canvas,
      MPLCONFIGDIR: path.join(APP_PATHS.cacheDir, 'matplotlib'),
      PYTHONPYCACHEPREFIX: path.join(APP_PATHS.cacheDir, 'python'),
      ...assetDirectoryEnvironment(plan, 'knowledge', 'TRANSPORTX_KNOWLEDGE_ASSETS_JSON'),
      ...assetDirectoryEnvironment(plan, 'data', 'TRANSPORTX_DATA_ASSETS_JSON'),
    }),
  };
}
