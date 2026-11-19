import { parseCase, type ResilienceCase } from './model.ts';
import { runPressureTest } from './engine.ts';

type Variable = 'edge-minutes' | 'service-capacity' | 'demand-amount' | 'closed-edge' | 'unavailable-resource';
type Axis = { variable: Variable; objectId: string; values: (number | boolean)[] };
type Request = { stateId: string; periodId: string; axes: Axis[]; constraints?: { maxPriorityShortage?: number; maxTotalShortage?: number } };
type Metric = { planId: string; priorityShortage: number; totalShortage: number; timely: boolean; meetsShortageLimits: boolean; feasible: boolean };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const compare = (a: Metric, b: Metric) => a.priorityShortage - b.priorityShortage || a.totalShortage - b.totalShortage || a.planId.localeCompare(b.planId, 'en');
const same = (a: string[], b: string[]) => a.join('\0') === b.join('\0');

/** Explicit Cartesian grid; all demand changes and outcomes apply to the selected period only. */
export function scanJointSensitivity(model: ResilienceCase, input: unknown) {
  parseCase(model);
  if (!record(input) || !keysOnly(input, ['stateId', 'periodId', 'axes', 'constraints']) || typeof input.stateId !== 'string' || typeof input.periodId !== 'string' || !Array.isArray(input.axes) || input.axes.length < 1 || input.axes.length > 3) throw new Error('Joint sensitivity requires stateId, periodId and 1–3 axes.');
  const state = model.states.find(s => s.id === input.stateId), period = model.periods.find(p => p.id === input.periodId);
  if (!state || !period) throw new Error('Joint sensitivity requires a known state and period.');
  const constraints = input.constraints;
  if (constraints !== undefined && (!record(constraints) || !keysOnly(constraints, ['maxPriorityShortage', 'maxTotalShortage']) || Object.values(constraints).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0))) throw new Error('Shortage limits must be finite nonnegative numbers.');
  const limits = (constraints ?? {}) as NonNullable<Request['constraints']>;
  const readyPlans = new Set(model.plans.filter(plan => (plan.setupMinutes ?? 0) <= model.decisionWindowMinutes).map(plan => plan.id));
  const resources = new Set([...model.edges, ...model.services].flatMap(o => o.requires));
  const seen = new Set<string>();
  const axes: Axis[] = input.axes.map((raw: unknown) => {
    if (!record(raw) || !keysOnly(raw, ['variable', 'objectId', 'values']) || typeof raw.variable !== 'string' || typeof raw.objectId !== 'string' || !Array.isArray(raw.values) || raw.values.length < 2 || raw.values.length > 12) throw new Error('Each axis needs a variable, objectId and 2–12 distinct values.');
    const variable = raw.variable as Variable, objectId = raw.objectId;
    const collection = variable === 'edge-minutes' || variable === 'closed-edge' ? model.edges : variable === 'service-capacity' ? model.services : variable === 'demand-amount' ? model.demands : null;
    if (!['edge-minutes', 'service-capacity', 'demand-amount', 'closed-edge', 'unavailable-resource'].includes(variable) || !(variable === 'unavailable-resource' ? resources.has(objectId) : collection?.some(o => o.id === objectId))) throw new Error('Unknown sensitivity variable or object ID.');
    const key = `${variable}\0${objectId}`;
    if (seen.has(key)) throw new Error('Duplicate sensitivity axis.');
    seen.add(key);
    const boolean = variable === 'closed-edge' || variable === 'unavailable-resource';
    if (new Set(raw.values).size !== raw.values.length || raw.values.some((v: unknown) => boolean ? typeof v !== 'boolean' : typeof v !== 'number' || !Number.isFinite(v) || (variable === 'edge-minutes' ? v <= 0 || v > 1440 : !Number.isInteger(v) || v < (variable === 'demand-amount' ? 1 : 0) || v > 1_000_000))) throw new Error('Axis values must be unique and within the variable bounds.');
    return { variable, objectId, values: [...raw.values].sort((a, b) => Number(a) - Number(b)) as (number | boolean)[] };
  });
  const count = axes.reduce((n, a) => n * a.values.length, 1);
  const slices = count * (2 + model.plans.length);
  if (count > 64 || slices * model.demands.length * (model.edges.length + model.nodes.length) > 24_000_000 || slices * model.demands.length * model.services.length > 180_000) throw new Error('Joint sensitivity workload exceeds the interactive limit. Reduce axes, values, plans, cohorts or network size.');
  const combinations: (number | boolean)[][] = [[]];
  for (const axis of axes) {
    const next = combinations.flatMap(prefix => axis.values.map(value => [...prefix, value]));
    combinations.splice(0, combinations.length, ...next);
  }
  const points = combinations.map((values, pointIndex) => {
    const change = structuredClone(state.periods[period.id] ?? {});
    const demands = structuredClone(model.demands);
    axes.forEach((axis, i) => {
      const value = values[i];
      if (axis.variable === 'edge-minutes') change.edgeMinutes = { ...change.edgeMinutes, [axis.objectId]: value as number };
      else if (axis.variable === 'service-capacity') change.serviceCapacity = { ...change.serviceCapacity, [axis.objectId]: value as number };
      else if (axis.variable === 'demand-amount') demands.find(d => d.id === axis.objectId)!.amount = value as number;
      else if (axis.variable === 'closed-edge' && value) change.closedEdges = [...new Set([...(change.closedEdges ?? []), axis.objectId])].sort();
      else if (axis.variable === 'unavailable-resource' && value) change.unavailableResources = [...new Set([...(change.unavailableResources ?? []), axis.objectId])].sort();
    });
    const restricted: ResilienceCase = { ...model, demands, periods: [period], states: [{ ...state, periods: { [period.id]: change } }], plans: model.plans.map(p => ({ ...p, periods: p.periods[period.id] ? { [period.id]: p.periods[period.id] } : {} })), investigations: [] };
    const result = runPressureTest(parseCase(restricted));
    const plans: Metric[] = result.scenarios.map(s => {
      const timely = readyPlans.has(s.planId);
      const meetsShortageLimits = (limits.maxPriorityShortage === undefined || s.priorityShortage <= limits.maxPriorityShortage) &&
        (limits.maxTotalShortage === undefined || s.shortage <= limits.maxTotalShortage);
      return { planId: s.planId, priorityShortage: s.priorityShortage, totalShortage: s.shortage, timely,
        meetsShortageLimits, feasible: timely && meetsShortageLimits };
    }).sort(compare);
    const feasible = plans.filter(p => p.feasible), best = feasible[0];
    const bestPlanIds = best ? feasible.filter(p => p.priorityShortage === best.priorityShortage && p.totalShortage === best.totalShortage).map(p => p.planId).sort() : [];
    const paretoPlanIds = feasible.filter(p => !feasible.some(q => q.priorityShortage <= p.priorityShortage && q.totalShortage <= p.totalShortage && (q.priorityShortage < p.priorityShortage || q.totalShortage < p.totalShortage))).map(p => p.planId).sort();
    return { pointIndex, values, plans, bestPlanIds, paretoPlanIds, feasible: !!best };
  });
  const lookup = new Map(points.map(p => [JSON.stringify(p.values), p]));
  const transitions = points.flatMap(point => axes.flatMap((axis, index) => {
    const at = axis.values.indexOf(point.values[index]);
    if (at === axis.values.length - 1) return [];
    const nextValues = [...point.values]; nextValues[index] = axis.values[at + 1];
    const next = lookup.get(JSON.stringify(nextValues))!;
    const nextLimits = new Map(next.plans.map(plan => [plan.planId, plan.meetsShortageLimits]));
    const changedPlanLimits = point.plans.filter(plan => plan.meetsShortageLimits !== nextLimits.get(plan.planId))
      .map(plan => ({ planId: plan.planId, from: plan.meetsShortageLimits, to: nextLimits.get(plan.planId)! }));
    if (same(point.bestPlanIds, next.bestPlanIds) && !changedPlanLimits.length) return [];
    return [{ axisIndex: index, fromPoint: point.pointIndex, toPoint: next.pointIndex, fromBestPlanIds: point.bestPlanIds, toBestPlanIds: next.bestPlanIds, fromFeasible: point.feasible, toFeasible: next.feasible, changedPlanLimits }];
  }));
  const origin = points[0];
  const interactions = points.flatMap(point => {
    const changed = point.values.map((v, i) => v !== origin.values[i] ? i : -1).filter(i => i >= 0);
    if (changed.length < 2) return [];
    const singles = changed.map(index => { const values = [...origin.values]; values[index] = point.values[index]; return lookup.get(JSON.stringify(values))!; });
    const reversal = origin.feasible && point.feasible && singles.every(single => same(single.bestPlanIds, origin.bestPlanIds)) && !same(point.bestPlanIds, origin.bestPlanIds);
    const jointBreach = origin.feasible && singles.every(single => single.feasible) && !point.feasible;
    if (!reversal && !jointBreach) return [];
    return [{ pointIndex: point.pointIndex, originPoint: origin.pointIndex, axisIndices: changed, singlePointIndices: singles.map(p => p.pointIndex), reversal, jointBreach, originBestPlanIds: origin.bestPlanIds, jointBestPlanIds: point.bestPlanIds }];
  });
  const axisLabel: Record<Variable, string> = { 'edge-minutes': '道路耗时', 'service-capacity': '服务容量',
    'demand-amount': '需求量', 'closed-edge': '道路关闭状态', 'unavailable-resource': '资源中断状态' };
  const describe = (index: number) => `${axes[index].objectId} 的${axisLabel[axes[index].variable]}`;
  const rawQuestions = [
    ...interactions.map(i => ({ question: `${period.id} 时段内，${i.axisIndices.map(describe).join('、')}是否会同时恶化？`, evidence: { kind: 'joint-interaction' as const, ...i } })),
    ...transitions.map(t => ({ question: `${period.id} 时段内，${describe(t.axisIndex)}实际处在哪一档？`, evidence: { kind: 'adjacent-transition' as const, ...t } })),
  ];
  const questionMap = new Map<string, typeof rawQuestions>();
  for (const candidate of rawQuestions) {
    const evidence = questionMap.get(candidate.question) ?? [];
    evidence.push(candidate);
    questionMap.set(candidate.question, evidence);
  }
  const candidateQuestions = [...questionMap].map(([question, candidates]) => ({ question, evidence: candidates.map(candidate => candidate.evidence) }));
  return { request: { stateId: state.id, periodId: period.id, axes, ...(constraints !== undefined ? { constraints: limits } : {}) }, units: 'person-periods' as const, assumptions: ['Only the selected period is evaluated, including any demand-amount change; no other period is changed.', 'Each numeric value replaces the selected state override; plan restrictions and existing closures and resource outages remain in force.', 'For binary axes false leaves existing state restrictions in place and true adds the restriction; it cannot reopen a closure.', 'First values define the reference point for single-versus-joint comparisons; values are sorted, not probabilistic.', 'Feasibility requires both setup within the decision window and the supplied shortage limits. Feasible plans minimize priority shortage, then total shortage; Pareto plans show the priority/total tradeoff.', 'Adjacent transitions and joint interactions describe tested points only; no interpolation or causal attribution is inferred.'], points, transitions, interactions, candidateQuestions };
}
