import type { NetworkChange, ResilienceCase } from './model.ts';

export type CohortResult = { demandId: string; priority: boolean; kind: string; demand: number; reachable: number; unreachable: number; served: number; capacityUnmet: number; shortage: number; reachableServiceIds: string[] };
export type PeriodResult = { periodId: string; weight: number; cohorts: CohortResult[]; demand: number; reachable: number; unreachable: number; served: number; capacityUnmet: number; shortage: number; priorityShortage: number; bottlenecks: { serviceId: string; capacity: number; used: number }[] };
export type ScenarioResult = { stateId: string; planId: string; periods: PeriodResult[]; shortage: number; priorityShortage: number; restored: number; priorityRestored: number };
export type PressureTestResult = { units: 'person-periods'; assumptions: string[]; baseline: PeriodResult[]; disrupted: { stateId: string; periods: PeriodResult[] }[]; scenarios: ScenarioResult[] };
type Arc = { to: number; rev: number; cap: number; initial: number };
const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id, 'en'));
const total = (periods: PeriodResult[], key: 'shortage' | 'priorityShortage') => periods.reduce((n, p) => n + p[key], 0);

/** Edges are directed. A plan may change surviving links or capacity, but cannot reopen a
 * state-closed link or restore a state-unavailable resource. Period weights count repeated
 * demand/capacity opportunities, not unique people. */
function evaluate(model: ResilienceCase, periodId: string, state: NetworkChange = {}, plan: NetworkChange = {}): PeriodResult {
  const period = model.periods.find(p => p.id === periodId)!;
  const closed = new Set([...(state.closedEdges ?? []), ...(plan.closedEdges ?? [])]);
  const unavailable = new Set([...(state.unavailableResources ?? []), ...(plan.unavailableResources ?? [])]);
  const usable = (requires: string[]) => requires.every(r => !unavailable.has(r));
  const edges = sorted(model.edges).filter(e => !closed.has(e.id) && usable(e.requires));
  const services = sorted(model.services).filter(s => usable(s.requires));
  const demands = sorted(model.demands);
  const capacities = services.map(s => {
    const stateCap = state.serviceCapacity?.[s.id], planCap = plan.serviceCapacity?.[s.id];
    return stateCap !== undefined && planCap !== undefined ? Math.min(stateCap, planCap) : planCap ?? stateCap ?? s.capacity;
  });
  const outgoing = new Map<string, typeof edges>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  const reachable: number[][] = demands.map(d => {
    const distances = new Map<string, number>([[d.node, 0]]);
    const heap: { node: string; distance: number }[] = [];
    const less = (a: typeof heap[number], b: typeof heap[number]) => a.distance < b.distance || (a.distance === b.distance && a.node < b.node);
    const push = (item: typeof heap[number]) => {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (!less(heap[index], heap[parent])) break;
        [heap[index], heap[parent]] = [heap[parent], heap[index]];
        index = parent;
      }
    };
    const pop = () => {
      const first = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let index = 0;
        while (true) {
          let child = index * 2 + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
          if (!less(heap[child], heap[index])) break;
          [heap[index], heap[child]] = [heap[child], heap[index]];
          index = child;
        }
      }
      return first;
    };
    push({ node: d.node, distance: 0 });
    while (heap.length) {
      const { node, distance } = pop();
      if (distance !== distances.get(node)) continue;
      if (distance > d.maxMinutes) break;
      for (const e of outgoing.get(node) ?? []) {
        if (!e.modes.includes(d.mode)) continue;
        const stateTime = state.edgeMinutes?.[e.id], planTime = plan.edgeMinutes?.[e.id];
        const minutes = stateTime !== undefined && planTime !== undefined ? Math.max(stateTime, planTime) : planTime ?? stateTime ?? e.minutes;
        const next = distance + minutes;
        if (next < (distances.get(e.to) ?? Infinity)) {
          distances.set(e.to, next);
          push({ node: e.to, distance: next });
        }
      }
    }
    return services.flatMap((s, i) => s.kind === d.kind && (distances.get(s.node) ?? Infinity) <= d.maxMinutes ? [i] : []);
  });
  // Residual arcs allow a flexible priority cohort to move when a constrained one
  // needs its original service. Source arcs cannot be traversed backwards by a
  // source-to-sink augmenting path, so adding ordinary cohorts preserves priority flow.
  const source = 0, demandOffset = 1, serviceOffset = demandOffset + demands.length, sink = serviceOffset + services.length;
  const graph: Arc[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (from: number, to: number, cap: number): Arc => {
    const f: Arc = { to, rev: graph[to].length, cap, initial: cap };
    const b: Arc = { to: from, rev: graph[from].length, cap: 0, initial: 0 };
    graph[from].push(f);
    graph[to].push(b);
    return f;
  };
  const sourceArcs = demands.map(() => null as Arc | null);
  demands.forEach((d, i) => reachable[i].forEach(j => add(demandOffset + i, serviceOffset + j, d.amount)));
  const serviceArcs = services.map((_, j) => add(serviceOffset + j, sink, capacities[j]));
  const flow = () => {
    while (true) {
      const previous: ({ node: number; arc: number } | null)[] = Array(graph.length).fill(null);
      const seen = new Set([source]);
      const queue = [source];
      for (let q = 0; q < queue.length && !seen.has(sink); q++) {
        const node = queue[q];
        graph[node].forEach((arc, i) => {
          if (arc.cap > 1e-9 && !seen.has(arc.to)) {
            seen.add(arc.to);
            previous[arc.to] = { node, arc: i };
            queue.push(arc.to);
          }
        });
      }
      if (!seen.has(sink)) break;
      let amount = Infinity;
      for (let node = sink; node !== source;) {
        const step = previous[node]!;
        amount = Math.min(amount, graph[step.node][step.arc].cap);
        node = step.node;
      }
      for (let node = sink; node !== source;) {
        const step = previous[node]!;
        const arc = graph[step.node][step.arc];
        arc.cap -= amount;
        graph[node][arc.rev].cap += amount;
        node = step.node;
      }
    }
  };
  for (const priority of [true, false]) {
    demands.forEach((d, i) => { if (d.priority === priority) sourceArcs[i] = add(source, demandOffset + i, d.amount); });
    flow();
  }
  const w = period.weight;
  const cohorts: CohortResult[] = demands.map((d, i) => {
    const served = (sourceArcs[i]!.initial - sourceArcs[i]!.cap) * w;
    const demand = d.amount * w, canReach = reachable[i].length > 0;
    return {
      demandId: d.id, priority: d.priority, kind: d.kind, demand, served,
      reachable: canReach ? demand : 0, unreachable: canReach ? 0 : demand,
      capacityUnmet: canReach ? Math.max(0, demand - served) : 0,
      shortage: Math.max(0, demand - served),
      reachableServiceIds: reachable[i].map(j => services[j].id),
    };
  });
  const sum = (key: 'demand' | 'reachable' | 'unreachable' | 'served' | 'capacityUnmet' | 'shortage') => cohorts.reduce((n, c) => n + c[key], 0);
  const bottlenecks = services.flatMap((service, index) => {
    const remaining = serviceArcs[index].cap;
    if (remaining > 1e-9 || !reachable.some(choices => choices.includes(index))) return [];
    const capacity = capacities[index];
    return [{ serviceId: service.id, capacity: capacity * w, used: (capacity - remaining) * w }];
  });
  return {
    periodId, weight: w, cohorts, demand: sum('demand'), reachable: sum('reachable'),
    unreachable: sum('unreachable'), served: sum('served'), capacityUnmet: sum('capacityUnmet'),
    shortage: sum('shortage'), priorityShortage: cohorts.filter(c => c.priority).reduce((n, c) => n + c.shortage, 0),
    bottlenecks,
  };
}

export function runPressureTest(model: ResilienceCase): PressureTestResult {
  const periods = sorted(model.periods);
  const baseline = periods.map(p => evaluate(model, p.id));
  const disrupted = sorted(model.states).map(state => ({ stateId: state.id, periods: periods.map(p => evaluate(model, p.id, state.periods[p.id])) }));
  const scenarios = sorted(model.states).flatMap(state => sorted(model.plans).map(plan => {
    const results = periods.map(p => evaluate(model, p.id, state.periods[p.id], plan.periods[p.id]));
    const reference = disrupted.find(d => d.stateId === state.id)!.periods;
    const shortage = total(results, 'shortage'), priorityShortage = total(results, 'priorityShortage');
    return {
      stateId: state.id, planId: plan.id, periods: results, shortage, priorityShortage,
      restored: total(reference, 'shortage') - shortage,
      priorityRestored: total(reference, 'priorityShortage') - priorityShortage,
    };
  }));
  return {
    units: 'person-periods', baseline, disrupted, scenarios,
    assumptions: [
      'Directed links and deterministic travel times. Each period is evaluated independently.',
      'Demand is allocated to reachable services by maximum flow, with priority demand served first.',
      'Period weights represent comparable occurrences. The same person may be counted in multiple periods.',
      'State closures and resource outages take precedence. Conflicting overrides use the longer travel time and lower capacity.',
      'The run uses fixed travel times and input demand.',
    ],
  };
}
