import fs from 'node:fs';
import path from 'node:path';
import { APP_PATHS, DEFAULT_DOMAIN_ID, PI_AGENT_DIR, TAU_SETTINGS } from './config.js';
import { ASSET_OVERRIDES, ASSET_RESOLVER, MODULE_INSTALLER, MODULE_REGISTRY, SESSION_ASSEMBLER } from './platform-composition.js';
import { dependsOnBuiltinSimulation } from './session-assembly.js';
import { verifyChecksumFile } from './asset-integrity.js';
import { ModuleRegistry, moduleRuntimeCompatible } from './module-registry.js';
import { platformOverview } from './platform-overview.js';
import { readToolContract } from './tool-contracts.js';
import { approvedHostToolContract } from './tool-request.js';
import { diagnoseTool } from './tool-diagnostics.js';
import { CORE_TOOL_BINDINGS } from '../contracts/tool-interface.js';
import { logHostError } from './diagnostic-log.js';
import type { PiRpcSession } from './sessions.js';

export function currentPlatformOverview(session: PiRpcSession | null | undefined, frozenPlan?: import('../contracts/index.js').ResolvedSessionPlanV3) {
  const storage = { root: PI_AGENT_DIR, scenario: TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir };
  const selectedPlan = frozenPlan || session?.resolvedSessionPlan;
  const withTools = (overview: ReturnType<typeof platformOverview>) => ({ ...overview, modules: overview.modules.map((module) => {
    const identities = CORE_TOOL_BINDINGS[module.id];
    if (!identities) return module;
    const selected = selectedPlan?.modules.find((item) => item.id === module.id);
    const toolDiagnostics = identities.map(({ toolId, piName }) => {
      const base = { moduleId: module.id, toolId, piName, contractVersion: 'unknown', ...(session?.id ? { sessionId: session.id } : {}) };
      try {
        const contract = readToolContract(selected?.packageRoot || MODULE_REGISTRY.get(module.id)!.packageRoot, module.id, toolId);
        if (!contract) return { ...base, state: 'unverified' as const, reason: 'missing_contract' };
        return diagnoseTool(contract, selected, session && !session.terminating && session.child ? session.capabilityTracker.observation() : undefined, session?.entries || [], session?.id, approvedHostToolContract(module.id, toolId));
      } catch {
        return { ...base, state: 'unavailable' as const, reason: 'invalid_contract' };
      }
    });
    return { ...module, toolDiagnostics };
  }) });
  try {
    const plan = selectedPlan || SESSION_ASSEMBLER.assemble(DEFAULT_DOMAIN_ID, storage.scenario);
    return withTools(platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(plan.assets.map((asset) => asset.id))));
  } catch (error) {
    logHostError('operation_failed', error);
    return withTools(platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(), String(error instanceof Error ? error.message : error)));
  }
}

export function currentSessionOptions() {
  const enabled = new Set(TAU_SETTINGS.enabledModuleIds);
  const defaultVersions = new Set(MODULE_INSTALLER.sources().map((source) => `${source.moduleId}:${path.basename(source.packageRoot!)}`));
  const platformModules = [...MODULE_REGISTRY.modules.values()].filter((module) => module.origin !== 'installed');
  const platformSources = platformModules.map((module) => ({ manifestPath: module.manifestPath, packageRoot: module.packageRoot, origin: module.origin }));
  const platformModuleIds = new Set(platformModules.map((module) => module.manifest.id));
  const defaultModuleIds = new Set(MODULE_REGISTRY.dependencyOrder('com.transportx.workbench').map((module) => module.manifest.id));
  return {
    schemaVersion: 1,
    modules: [
      ...MODULE_INSTALLER.catalog().filter((entry) => !platformModuleIds.has(entry.id)),
      ...platformModules.filter((module) => module.origin === 'builtin' && module.enabled && module.manifest.type === 'capability' && !defaultModuleIds.has(module.manifest.id)).map((module) => ({ id: module.manifest.id, version: module.manifest.version, manifest: module.manifest, source: { manifestPath: module.manifestPath, packageRoot: module.packageRoot, origin: module.origin } })),
    ].map((entry) => {
      const runtime = moduleRuntimeCompatible(entry.manifest);
      let dependenciesCompatible = false;
      let requiresExplicitSelection = entry.source.origin === 'builtin';
      try {
        const selectedSources = MODULE_INSTALLER.sourcesForSelectionsWithDependencies([{ id: entry.id, version: entry.version }], platformModuleIds);
        const selectionRegistry = new ModuleRegistry(MODULE_REGISTRY.platformVersion).load([...platformSources, ...selectedSources]);
        dependenciesCompatible = selectionRegistry.errors.length === 0 && selectionRegistry.get(entry.id)?.enabled === true;
        if (dependenciesCompatible && !requiresExplicitSelection) requiresExplicitSelection = dependsOnBuiltinSimulation(selectionRegistry, entry.id);
      } catch {}
      const compatible = runtime.compatible && dependenciesCompatible;
      return {
        id: entry.id,
        name: entry.manifest.name,
        ...(entry.manifest.presentation ? { presentation: entry.manifest.presentation } : {}),
        version: entry.version,
        type: entry.manifest.type,
        origin: entry.source.origin,
        compatible,
        enabledForNewSessions: compatible && (entry.source.origin === 'builtin' || enabled.has(entry.id)),
        selectedByDefault: compatible && !requiresExplicitSelection && enabled.has(entry.id) && defaultVersions.has(`${entry.id}:${entry.version}`),
        dependencies: entry.manifest.dependencies,
        assets: (entry.manifest.contributes?.assets || []).map((asset) => {
          const assetPath = path.resolve((ASSET_OVERRIDES as Record<string, string>)[asset.id] || path.resolve(entry.source.packageRoot!, asset.path));
          const integrityFile = asset.integrityFile ? (fs.existsSync(path.resolve(entry.source.packageRoot!, asset.integrityFile)) ? path.resolve(entry.source.packageRoot!, asset.integrityFile) : path.join(assetPath, path.basename(asset.integrityFile))) : '';
          let integrity: 'verified' | 'unverified' | 'missing' = asset.integrityFile ? 'missing' : 'unverified';
          if (asset.integrityFile && fs.existsSync(assetPath) && fs.existsSync(integrityFile)) try { verifyChecksumFile(assetPath, integrityFile); integrity = 'verified'; } catch { integrity = 'missing'; }
          return { id: asset.id, kind: asset.kind, configured: fs.existsSync(assetPath), integrity };
        }),
      };
    }),
  };
}
