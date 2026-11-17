import type { ResilienceCase } from './model.ts';
import { runPressureTest } from './engine.ts';

export type SensitivitySweep = { stateId: string; periodId: string; objectId: string; variable: 'edge-minutes' | 'service-capacity'; values: number[] };
export type SensitivityResult = { sweep: SensitivitySweep; units: 'person-periods'; assumptions: string[]; points: { value: number; plans: { planId: string; priorityShortage: number; totalShortage: number }[]; bestPlanIds: string[] }[]; brackets: { lowerValue: number; upperValue: number; lowerBestPlanIds: string[]; upperBestPlanIds: string[] }[] };

/** Independent scenario slices, with no interpolation between explicit inputs. */
export function scanSensitivity(model: ResilienceCase, sweep: SensitivitySweep): SensitivityResult {
  const state = model.states.find(s => s.id === sweep.stateId);
  const period = model.periods.find(p => p.id === sweep.periodId);
  if (!state || !period) throw new Error('Sensitivity sweep requires a known state and period.');
  if (sweep.variable !== 'edge-minutes' && sweep.variable !== 'service-capacity') throw new Error('Unsupported sensitivity variable.');
  if (!(sweep.variable === 'edge-minutes' ? model.edges : model.services).some(x => x.id === sweep.objectId)) throw new Error('Sensitivity object does not match the selected variable.');
  if (sweep.values.length < 2 || sweep.values.length > 12 || new Set(sweep.values).size !== sweep.values.length || sweep.values.some(v => !Number.isFinite(v) || (sweep.variable === 'edge-minutes' ? v <= 0 || v > 1440 : !Number.isInteger(v) || v < 0 || v > 1_000_000))) throw new Error('Sensitivity requires 2–12 unique, bounded values: positive edge minutes or nonnegative integer service capacity.');
  const slices = sweep.values.length * (2 + model.plans.length);
  if (slices * model.demands.length * (model.edges.length + model.nodes.length) > 24_000_000 || slices * model.demands.length * model.services.length > 180_000) throw new Error('Sensitivity workload exceeds the interactive limit. Reduce values, plans, cohorts or network size.');
  const values = [...sweep.values].sort((a, b) => a - b);
  const points = values.map(value => {
    const existing = state.periods[period.id] ?? {};
    const change = sweep.variable === 'edge-minutes'
      ? { ...existing, edgeMinutes: { ...existing.edgeMinutes, [sweep.objectId]: value } }
      : { ...existing, serviceCapacity: { ...existing.serviceCapacity, [sweep.objectId]: value } };
    const restricted: ResilienceCase = { ...model, periods: [period], states: [{ ...state, periods: { [period.id]: change } }], investigations: [] };
    const result = runPressureTest(restricted);
    const plans = result.scenarios.map(s => ({ planId: s.planId, priorityShortage: s.priorityShortage, totalShortage: s.shortage }));
    const ordered = [...plans].sort((a, b) => a.priorityShortage - b.priorityShortage || a.totalShortage - b.totalShortage || a.planId.localeCompare(b.planId, 'en'));
    const best = ordered[0];
    const bestPlanIds = ordered.filter(p => p.priorityShortage === best.priorityShortage && p.totalShortage === best.totalShortage).map(p => p.planId);
    return { value, plans, bestPlanIds };
  });
  const brackets = points.slice(1).flatMap((point, i) => {
    const previous = points[i];
    return previous.bestPlanIds.join('\0') === point.bestPlanIds.join('\0') ? [] : [{ lowerValue: previous.value, upperValue: point.value, lowerBestPlanIds: previous.bestPlanIds, upperBestPlanIds: point.bestPlanIds }];
  });
  return { sweep: { ...sweep, values }, units: 'person-periods', assumptions: ['Each value replaces the selected state override for the selected period only; all other state and plan constraints remain in force.', 'State closures and unavailable shared resources remain in force; conflicting plan overrides use the more restrictive value.', 'Priority shortage is minimized first, then total shortage; all tied plans are listed.', 'A bracket means the best set differs at two adjacent tested values. No threshold or interpolation is inferred between them.'], points, brackets };
}
