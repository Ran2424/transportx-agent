import fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { canonicalToolSchema, parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import type { ToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';

// Supplied only by Host after validating the frozen plan; never from tool input.
export type SessionModule = {
  id: string; version: string; name: string; description: string;
  searchText: string; extensions: string[]; skills: string[];
  contracts: ToolInterfaceContract[];
};
export type Tool = ReturnType<ExtensionAPI['getAllTools']>[number];
export type ModuleTools = { module: SessionModule; tools: Tool[]; reasons: string[] };
export const BASE_TOOLS = ['read', 'write', 'edit', 'bash', 'manage_capabilities'];
export const ACTIVATION_ENTRY = 'transportx-tool-activation/v1';
export const ACTIVATION_EVENT = 'transportx:tool-activation-changed';

function real(file: string) {
  try { return fs.realpathSync(file); } catch { return undefined; }
}

export function readSessionModules(): SessionModule[] {
  const value = JSON.parse(process.env.TRANSPORTX_SESSION_MODULES_JSON || 'null');
  if (!Array.isArray(value)) throw new Error('Host-verified session modules are missing');
  return value.map((module) => ({ ...module, contracts: (module.contractFiles || []).map((file: string) => {
    const contract = parseToolInterfaceContract(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!contract || contract.moduleId !== module.id) throw new Error('Invalid module Tool Contract');
    return contract;
  }) }));
}

export function moduleTools(modules: SessionModule[], all: Tool[]): ModuleTools[] {
  const owners = new Map<string, string[]>();
  for (const module of modules) for (const entry of module.extensions) {
    const source = real(entry);
    if (source) owners.set(source, [...new Set([...(owners.get(source) || []), module.id])]);
  }
  return modules.map((module) => {
    const reasons: string[] = [];
    for (const entry of module.extensions) {
      const source = real(entry);
      if (!source) reasons.push('extension_missing');
      else if (owners.get(source)?.length !== 1) reasons.push('ambiguous_source');
    }
    const tools = all.filter((tool) => {
      const source = tool.sourceInfo?.path && real(tool.sourceInfo.path);
      return source && owners.get(source)?.length === 1 && owners.get(source)?.[0] === module.id;
    });
    for (const contract of module.contracts) {
      const tool = tools.find((item) => item.name === contract.piName);
      if (!tool) reasons.push(all.some((item) => item.name === contract.piName) ? `name_conflict:${contract.piName}` : `missing_tool:${contract.piName}`);
      else if (canonicalToolSchema(tool.parameters) !== canonicalToolSchema(contract.input)) reasons.push(`schema_drift:${tool.name}`);
    }
    return { module, tools, reasons: [...new Set(reasons)] };
  });
}

export function baseTools(all: Tool[], rows: ModuleTools[]) {
  return BASE_TOOLS.filter((name) => name === 'manage_capabilities'
    ? rows.some((row) => row.module.id === 'com.transportx.tool-activation' && !row.reasons.length && row.tools.some((tool) => tool.name === name))
    : all.some((tool) => tool.name === name && tool.sourceInfo?.source === 'builtin' && tool.sourceInfo.path === `<builtin:${name}>`));
}

export function members(row: ModuleTools) { return row.tools.map((tool) => tool.name).sort(); }
export function identity(row: ModuleTools) { return `${row.module.id}@${row.module.version}`; }
export function sameMembers(a: string[], b: string[]) { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }

export function summarize(row: ModuleTools, active: Set<string>) {
  const activeCount = row.tools.filter((tool) => active.has(tool.name)).length;
  return {
    moduleId: row.module.id, moduleVersion: row.module.version, name: row.module.name,
    description: row.module.description.slice(0, 400), selected: true,
    registeredCount: row.tools.length, totalCount: row.tools.length, activeCount,
    state: row.reasons.length ? 'incompatible' : !row.tools.length ? 'no_tools' : !activeCount ? 'pending_activation' : activeCount === row.tools.length ? 'enabled' : 'partially_active',
    reasons: row.reasons,
  };
}

export function discover(rows: ModuleTools[], active: Set<string>, query = '') {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const ranked = rows.map((row) => {
    const { module, tools } = row;
    const text = `${module.id} ${module.name} ${module.description} ${module.searchText} ${tools.map((tool) => `${tool.name} ${tool.description}`).join(' ')}`.toLocaleLowerCase();
    const matched = terms.filter((term) => text.includes(term));
    const exact = terms.some((term) => term === module.id.toLocaleLowerCase() || term === module.name.toLocaleLowerCase());
    return { row, matched, score: (exact ? 100 : 0) + matched.length };
  }).filter((item) => !terms.length || item.score).sort((a, b) => b.score - a.score || a.row.module.id.localeCompare(b.row.module.id));
  const limit = terms.length ? 5 : 20;
  return { total: ranked.length, truncated: ranked.length > limit, modules: ranked.slice(0, limit).map(({ row, matched }) => ({ ...summarize(row, active), matched, matchingTools: row.tools.filter((tool) => terms.some((term) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(term))).slice(0, 3).map((tool) => tool.name) })), guide: 'Narrow query or inspect(moduleId, toolName) for details.' };
}

export function inspect(row: ModuleTools, active: Set<string>, toolName?: string) {
  const tools = toolName ? row.tools.filter((tool) => tool.name === toolName) : row.tools.slice(0, 20);
  return {
    ...summarize(row, active), ...(toolName && !tools.length ? { error: 'tool_not_in_module' } : {}),
    total: row.tools.length, truncated: !toolName && row.tools.length > 20,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 500), ...(toolName ? {
      parameters: Object.entries((tool.parameters as { properties?: Record<string, { type?: string; description?: string }> }).properties || {}).slice(0, 30).map(([name, value]) => ({ name, type: value.type || 'union', description: value.description?.slice(0, 160) })),
      result: row.module.contracts.find((contract) => contract.piName === tool.name)?.output || 'See tool result; no platform contract declared',
    } : {}) })), skillEntries: row.module.skills,
  };
}
