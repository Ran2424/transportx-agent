const fs = require('node:fs');
const path = require('node:path');

import { APP_PATHS, PI_COMMAND_ARGS, PI_AGENT_DIR, PYTHON_COMMAND, SESSIONS_DIR } from './config.js';
import { assertPiResourceBoundary, piProcessEnv } from './pi-runtime.js';
import { planExtensions, planPromptPath, planSkills, type ResolvedSessionPlan } from './session-assembly.js';
import { loadProjectPrompt, loadSystemPrompt } from './session-prompt.js';
import type { SessionService } from './session-service.js';
import { projectAdapter } from './project-adapter.js';
import { readModuleToolContracts } from './tool-contracts.js';
import { CORE_TOOL_BINDINGS } from '../contracts/tool-interface.js';

function sessionModules(plan: ResolvedSessionPlan) {
  return plan.modules.map((module) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(module.packageRoot, 'manifest.json'), 'utf8'));
    const skills = module.entrypoints.filter((entry) => entry.kind === 'skill').map((entry) => entry.path);
    return {
      id: module.id, version: module.version, name: manifest.name, description: manifest.description || '',
      searchText: [JSON.stringify(manifest.presentation || {}), ...skills.map((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return text.startsWith('---') ? text.slice(0, text.indexOf('\n---', 3) + 4).slice(0, 16000) : '';
      })].join(' '),
      extensions: module.entrypoints.filter((entry) => entry.kind === 'extension').map((entry) => entry.path), skills,
      contractFiles: (CORE_TOOL_BINDINGS[module.id] || []).filter((binding) => fs.existsSync(path.join(module.packageRoot, binding.file))).map((binding) => path.join(module.packageRoot, binding.file)),
    };
  });
}

export type SessionPiLaunchInput = {
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
  assertPiResourceBoundary(PI_COMMAND_ARGS);
  for (const module of plan.modules) readModuleToolContracts(module.packageRoot, module.id);
  const args = [...PI_COMMAND_ARGS, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--system-prompt', loadSystemPrompt()];
  for (const extensionPath of projectAdapter.piExtensions(APP_PATHS.appRoot)) {
    if (!fs.existsSync(extensionPath)) throw new Error(`Project extension not found: ${extensionPath}`);
    args.push('--extension', extensionPath);
  }
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
      TRANSPORTX_SESSION_MODULES_JSON: JSON.stringify(sessionModules(plan)),
      TAU_MODULE_ENDPOINT: input.endpoints.moduleAuthoring,
      TAU_MODULE_SESSION_ID: input.sessionId,
      TAU_MODULE_TOKEN: input.serviceTokens.moduleAuthoring,
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
