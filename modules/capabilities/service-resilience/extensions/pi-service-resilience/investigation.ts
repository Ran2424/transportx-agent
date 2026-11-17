import type { ResilienceCase } from './model.ts';
import type { PressureTestResult, ScenarioResult } from './engine.ts';

export type Regret = { priorityShortage: number; totalShortage: number };
type Choice = { recommendedPlanId: string | null; tiedPlanIds: string[]; worstRegret: Regret | null };
export type ConditionalAction = Choice & { outcome: string; stateIds: string[]; remainingAmbiguity: boolean; stateBestPlanIds: Record<string, string[]>; uniformlyWorsePlanIds: string[] };
export type InvestigationRanking = { decisionWindowMinutes: number; assumptions: string[]; beforeObservation: Choice & { eligiblePlanIds: string[] }; investigations: { investigationId: string; question: string; source: string; effort: string; leadMinutes: number; timely: boolean; eligiblePlanIds: string[]; blockedPlanIds: string[]; worstRegret: Regret | null; improvement: Regret | null; decision: 'wait' | 'act-now' | 'no-feasible-plan'; retainedDefaultPlanId: string | null; outcomes: ConditionalAction[] }[] };
const compare = (a: Regret, b: Regret) => a.priorityShortage - b.priorityShortage || a.totalShortage - b.totalShortage;
const value = (s: ScenarioResult): Regret => ({ priorityShortage: s.priorityShortage, totalShortage: s.shortage });
const subtract = (a: Regret, b: Regret): Regret => ({ priorityShortage: a.priorityShortage - b.priorityShortage, totalShortage: a.totalShortage - b.totalShortage });
const compareIds = (a: string, b: string) => a.localeCompare(b, 'en');

/** Regret uses one state-specific benchmark shared by pre- and post-observation
 * decisions: the best plan available if started now, ordered by priority then
 * total shortage. Waiting cannot claim a benefit by changing that benchmark. */
export function rankInvestigations(model: ResilienceCase, result: PressureTestResult): InvestigationRanking {
  const states = model.states.map(s => s.id).sort(compareIds);
  const plans = model.plans.map(p => p.id).sort(compareIds);
  if (!states.length || !plans.length) throw new Error('At least one state and one plan are required for minimax regret.');
  const setup = (id: string) => (model.plans.find(p => p.id === id) as (typeof model.plans)[number] & { setupMinutes?: number }).setupMinutes ?? 0;
  const eligibleNow = plans.filter(p => setup(p) <= model.decisionWindowMinutes);
  const find = (stateId: string, planId: string) => {
    const scenario = result.scenarios.find(s => s.stateId === stateId && s.planId === planId);
    if (!scenario) throw new Error(`Missing scenario for state ${stateId} and plan ${planId}.`);
    return scenario;
  };
  const best = new Map(states.map(state => [state, eligibleNow.map(p => value(find(state, p))).sort(compare)[0]]));
  const regret = (state: string, plan: string) => subtract(value(find(state, plan)), best.get(state)!);
  const select = (subset: string[], candidates: string[]): Choice => {
    if (!candidates.length) return { recommendedPlanId: null, tiedPlanIds: [], worstRegret: null };
    const options = candidates.map(planId => ({ planId, worstRegret: subset.map(s => regret(s, planId)).sort((a, b) => compare(b, a))[0] }));
    options.sort((a, b) => compare(a.worstRegret, b.worstRegret) || compareIds(a.planId, b.planId));
    return { recommendedPlanId: options[0].planId, tiedPlanIds: options.filter(o => compare(o.worstRegret, options[0].worstRegret) === 0).map(o => o.planId), worstRegret: options[0].worstRegret };
  };
  const before = select(states, eligibleNow);
  const investigations = model.investigations.map(inv => {
    const timely = inv.leadMinutes <= model.decisionWindowMinutes;
    const eligiblePlanIds = eligibleNow.filter(p => inv.leadMinutes + setup(p) <= model.decisionWindowMinutes);
    const blockedPlanIds = plans.filter(p => !eligiblePlanIds.includes(p));
    const seen = new Set<string>();
    const groups = inv.outcomes.map(o => {
      const ids = [...new Set(o.stateIds)].sort(compareIds);
      for (const id of ids) {
        if (!best.has(id)) throw new Error(`Investigation ${inv.id} refers to unknown state ${id}.`);
        seen.add(id);
      }
      return { label: o.label, ids };
    }).filter(o => o.ids.length > 0);
    const missing = states.filter(s => !seen.has(s));
    if (missing.length) groups.push({ label: 'Unspecified outcome', ids: missing });
    const outcomes: ConditionalAction[] = groups.map(g => {
      const choice = select(g.ids, eligiblePlanIds);
      const stateBestPlanIds: Record<string, string[]> = {};
      for (const state of g.ids) {
        const stateBest = eligiblePlanIds.map(p => value(find(state, p))).sort(compare)[0];
        stateBestPlanIds[state] = stateBest ? eligiblePlanIds.filter(p => compare(value(find(state, p)), stateBest) === 0) : [];
      }
      const selected = choice.recommendedPlanId;
      const uniformlyWorsePlanIds = selected === null ? [] : eligiblePlanIds.filter(p => p !== selected && g.ids.every(s => compare(value(find(s, p)), value(find(s, selected))) > 0));
      return { outcome: g.label, stateIds: g.ids, ...choice, remainingAmbiguity: g.ids.length > 1, stateBestPlanIds, uniformlyWorsePlanIds };
    });
    const worst = outcomes.map(o => o.worstRegret).filter((r): r is Regret => r !== null).sort((a, b) => compare(b, a))[0] ?? null;
    const improvement = before.worstRegret && worst ? subtract(before.worstRegret, worst) : null;
    const decision: 'wait' | 'act-now' | 'no-feasible-plan' = before.recommendedPlanId === null ? 'no-feasible-plan' : worst && before.worstRegret && compare(worst, before.worstRegret) < 0 ? 'wait' : 'act-now';
    return { investigationId: inv.id, question: inv.question, source: inv.source, effort: inv.effort, leadMinutes: inv.leadMinutes, timely, eligiblePlanIds, blockedPlanIds, worstRegret: worst, improvement, decision, retainedDefaultPlanId: before.recommendedPlanId, outcomes };
  });
  investigations.sort((a, b) => Number(b.decision === 'wait') - Number(a.decision === 'wait') || Number(b.timely) - Number(a.timely) || (a.worstRegret && b.worstRegret ? compare(a.worstRegret, b.worstRegret) : 0) || compareIds(a.investigationId, b.investigationId));
  return { decisionWindowMinutes: model.decisionWindowMinutes, assumptions: ['The listed states are exhaustive and credible; no probabilities are assigned.', 'Outcomes accurately identify one of their listed states; missing states are retained as an unspecified outcome.', 'Plan setup starts immediately after the decision; missing setup time is zero. An observation blocks plans that cannot finish setup by the deadline.', 'The state benchmark is the best plan that could start now; minimax regret compares priority shortage first and total shortage second.', 'A tied or adverse wait retains the pre-observation plan; tied plan IDs are shown, with the first ID chosen deterministically.', 'Late or infeasible observations cannot improve the pre-deadline decision. Regret components are lexicographic differences, so the second component can be negative.'], beforeObservation: { ...before, eligiblePlanIds: eligibleNow }, investigations };
}
