import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ACTIVATION_ENTRY, ACTIVATION_EVENT, baseTools, identity, members, moduleTools, sameMembers, type ModuleTools, type SessionModule } from './module-tools.ts';

type AssemblyRecord = { kind: 'assembly'; modules: Record<string, string[]> };
type EnableRecord = { kind: 'enable'; moduleId: string; moduleVersion: string; tools: string[] };
type ActivationRecord = AssemblyRecord | EnableRecord;

export function activation(pi: ExtensionAPI, modules: SessionModule[]) {
  let frozen: Record<string, string[]> = {};
  let persistenceError: string | undefined;
  const records = (ctx: ExtensionContext): ActivationRecord[] => ctx.sessionManager.getBranch()
    .filter((entry) => entry.type === 'custom' && entry.customType === ACTIVATION_ENTRY)
    .map((entry) => (entry as { data: ActivationRecord }).data);
  const rows = () => moduleTools(modules, pi.getAllTools()).map((row) => {
    if (!sameMembers(frozen[identity(row)] || [], members(row))) row.reasons.push('registration_changed_requires_new_session');
    return row;
  });
  const notify = () => pi.events.emit(ACTIVATION_EVENT, {});
  const restore = (ctx: ExtensionContext) => {
    persistenceError = undefined;
    const entries = records(ctx);
    const current = moduleTools(modules, pi.getAllTools());
    const saved = entries.find((entry) => entry.kind === 'assembly');
    frozen = saved?.kind === 'assembly' ? saved.modules : Object.fromEntries(current.map((row) => [identity(row), members(row)]));
    // One native branch log is the only persistence mechanism, including the
    // initialization membership needed to reject changes across reload/resume.
    if (!saved) {
      try { pi.appendEntry(ACTIVATION_ENTRY, { kind: 'assembly', modules: frozen } satisfies AssemblyRecord); }
      catch { persistenceError = 'assembly_record_failed'; }
    }
    const checked = rows();
    const names = baseTools(pi.getAllTools(), checked);
    for (const entry of entries) {
      if (entry.kind !== 'enable') continue;
      const row = checked.find((item) => item.module.id === entry.moduleId);
      if (row && !row.reasons.length && row.module.version === entry.moduleVersion && sameMembers(entry.tools, members(row))) names.push(...entry.tools);
    }
    pi.setActiveTools([...new Set(names)]);
    notify();
  };
  const enable = (row: ModuleTools, ctx: ExtensionContext) => {
    if (row.reasons.length || persistenceError) return { status: 'incompatible', reasons: [...row.reasons, ...(persistenceError ? [persistenceError] : [])] };
    const names = members(row);
    if (!names.length) return { status: 'no_tools', newlyActive: [], alreadyActive: [] };
    const before = pi.getActiveTools();
    pi.setActiveTools([...new Set([...before, ...names])]);
    const after = new Set(pi.getActiveTools());
    const result = { newlyActive: names.filter((name) => !before.includes(name) && after.has(name)), alreadyActive: names.filter((name) => before.includes(name)), activeTools: [...after] };
    if (names.some((name) => !after.has(name))) return { ...result, status: 'activation_failed' };
    const recorded = records(ctx).some((entry) => entry.kind === 'enable' && entry.moduleId === row.module.id && entry.moduleVersion === row.module.version && sameMembers(entry.tools, names));
    if (!recorded) {
      try { pi.appendEntry(ACTIVATION_ENTRY, { kind: 'enable', moduleId: row.module.id, moduleVersion: row.module.version, tools: names } satisfies EnableRecord); }
      catch { notify(); return { ...result, status: 'active_but_record_failed', reasons: ['activation_record_failed'], guide: 'Tools are active in this process; enable again to persist. No business operation was executed.' }; }
    }
    notify();
    return { ...result, status: 'enabled', skillEntries: row.module.skills, guide: 'Read skills when needed, then call the original tools. Activation does not execute or authorize business operations.' };
  };
  return { rows, restore, enable, persistenceError: () => persistenceError };
}
