import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ManageCapabilitiesSchema } from '../../../../../src/contracts/tool-definitions.mts';
import { activation } from './activation.ts';
import { BASE_TOOLS, discover, inspect, readSessionModules, summarize } from './module-tools.ts';

export default function toolActivation(pi: ExtensionAPI) {
  const modules = readSessionModules();
  const state = activation(pi, modules);
  pi.on('session_start', (_event, ctx) => state.restore(ctx));
  pi.on('session_tree', (_event, ctx) => state.restore(ctx));
  pi.registerTool({
    name: 'manage_capabilities', label: 'Manage capabilities',
    description: 'Discover/search modules in this session, inspect their tools and skills, enable all tools of a module, or query status. Read-only actions do not enable tools. Known module IDs can be enabled directly; activation does not execute business operations.',
    parameters: ManageCapabilitiesSchema,
    async execute(_id, input, _signal, _update, ctx) {
      const { action, moduleId, toolName, query } = input;
      const allowed = action === 'discover' ? ['action', 'query'] : action === 'inspect' ? ['action', 'moduleId', 'toolName'] : ['action', 'moduleId'];
      if (Object.keys(input).some((key) => !allowed.includes(key)) || (['inspect', 'enable'].includes(action) && !moduleId)) throw new Error(`Invalid fields for ${action}`);
      const rows = state.rows(), active = new Set(pi.getActiveTools());
      const row = moduleId ? rows.find((item) => item.module.id === moduleId) : undefined;
      let result: object;
      if (moduleId && !row) result = { moduleId, status: 'not_in_session_plan' };
      else if (action === 'discover') result = discover(rows, active, query);
      else if (action === 'inspect') result = inspect(row!, active, toolName);
      else if (action === 'enable') result = { moduleId: row!.module.id, moduleVersion: row!.module.version, ...state.enable(row!, ctx) };
      else {
        const selected = row ? [row] : rows.slice(0, 20);
        const owned = new Set(rows.flatMap((item) => item.tools.map((tool) => tool.name)));
        result = { modules: selected.map((item) => summarize(item, active)), total: rows.length, truncated: !row && rows.length > 20, observedAt: new Date().toISOString(),
          activeTools: [...active], reasons: [...BASE_TOOLS.filter((name) => !active.has(name)).map((name) => `base_tool_unavailable:${name}`), ...(state.persistenceError() ? [state.persistenceError()] : [])],
          unownedTools: pi.getAllTools().filter((tool) => tool.sourceInfo?.source !== 'builtin' && !owned.has(tool.name)).slice(0, 20).map((tool) => tool.name) };
      }
      const details = { kind: 'transportx-capability-management', version: 1, action, ...result };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}
