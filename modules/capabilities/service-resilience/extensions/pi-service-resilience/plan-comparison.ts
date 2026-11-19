import { parseCase, type ResilienceCase } from './model.ts';

export type ConfirmedChange = { eventId: string; objectId: string; periodId: string; action: 'close-edge' | 'close-service' };
export type ComparisonDefinition = { stateIds?: string[]; plans?: ResilienceCase['plans'] };

/** Build a separate, validated case. A confirmation is bound to exactly one state and period. */
export function defineComparison(model: ResilienceCase, planData: unknown, confirmedChanges: ConfirmedChange[], stateId?: string): ResilienceCase {
  parseCase(model);
  if (!planData || typeof planData !== 'object' || Array.isArray(planData) || Object.keys(planData).some(k => k !== 'stateIds' && k !== 'plans')) throw new Error('Comparison definition must contain only stateIds and/or plans.');
  const definition = planData as ComparisonDefinition;
  if (definition.stateIds !== undefined && (!Array.isArray(definition.stateIds) || !definition.stateIds.length || definition.stateIds.some(id => typeof id !== 'string') || new Set(definition.stateIds).size !== definition.stateIds.length)) throw new Error('stateIds must be a nonempty array of distinct state IDs.');
  const selected = definition.stateIds ?? model.states.map(s => s.id);
  if (selected.some(id => !model.states.some(s => s.id === id))) throw new Error('Unknown comparison state ID.');
  if (!Array.isArray(confirmedChanges)) throw new Error('confirmedChanges must be an array.');
  if (confirmedChanges.length && (!stateId || !selected.includes(stateId))) throw new Error('Confirmed changes require a selected, explicit stateId.');
  if (stateId && !selected.includes(stateId)) throw new Error('Confirmed change stateId must be selected.');
  const copy = structuredClone(model);
  copy.states = copy.states.filter(s => selected.includes(s.id));
  copy.investigations = copy.investigations.map(inv => ({ ...inv, outcomes: inv.outcomes.map(o => ({ ...o, stateIds: o.stateIds.filter(id => selected.includes(id)) })).filter(o => o.stateIds.length) }));
  if (definition.plans !== undefined) copy.plans = structuredClone(definition.plans);
  const seenBindings = new Set<string>();
  for (const item of confirmedChanges) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['eventId', 'objectId', 'periodId', 'action'].includes(k)) || typeof item.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(item.eventId) || typeof item.objectId !== 'string' || typeof item.periodId !== 'string' || !['close-edge', 'close-service'].includes(item.action)) throw new Error('Invalid confirmed change.');
    if (!copy.periods.some(p => p.id === item.periodId)) throw new Error(`Unknown confirmed change period: ${item.periodId}`);
    if (!(item.action === 'close-edge' ? copy.edges : copy.services).some(o => o.id === item.objectId)) throw new Error(`Unknown confirmed change object: ${item.objectId}`);
    const key = `${item.eventId}\0${item.action}\0${item.objectId}\0${item.periodId}`;
    if (seenBindings.has(key)) throw new Error('Duplicate confirmed change binding.');
    seenBindings.add(key);
    const state = copy.states.find(s => s.id === stateId)!;
    const change = state.periods[item.periodId] ?? (state.periods[item.periodId] = {});
    if (item.action === 'close-edge') change.closedEdges = [...new Set([...(change.closedEdges ?? []), item.objectId])].sort();
    else change.closedServices = [...new Set([...(change.closedServices ?? []), item.objectId])].sort();
  }
  return parseCase(copy);
}
