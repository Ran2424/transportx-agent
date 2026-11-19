import type { ResilienceCase } from './model.ts';
import { networkSlice, routeTo, shortestPaths, sorted } from './network-slice.ts';

export type AccessView = { periodId: string; stateId?: string; planId?: string; demandId?: string };
type Network = ReturnType<typeof networkSlice>;
type Demand = ResilienceCase['demands'][number];

function accessFor(demand: Demand, network: Network, cache: Map<string, ReturnType<typeof shortestPaths>>) {
  const services = network.services.filter(service => service.kind === demand.kind);
  const key = demand.node + '/' + demand.mode;
  let paths = cache.get(key);
  if (!paths) {
    paths = shortestPaths(network, demand.node, demand.mode);
    cache.set(key, paths);
  }
  const candidates = services.flatMap(service => {
    const minutes = paths.distances.get(service.node);
    return minutes === undefined ? [] : [{ service, minutes }];
  }).sort((a, b) => a.minutes - b.minutes || a.service.id.localeCompare(b.service.id, 'en'));
  const first = candidates[0];
  if (!first) return {
    status: services.length ? 'no-path' as const : 'no-open-service' as const,
    nearest: null, serviceOptions: [],
  };
  const serviceOptions = candidates.filter(candidate => candidate.minutes <= demand.maxMinutes).map(({ service, minutes }) =>
    ({ serviceId: service.id, minutes, capacity: service.capacity }));
  return {
    status: serviceOptions.length ? 'within-threshold' as const : 'beyond-threshold' as const,
    nearest: { serviceId: first.service.id, minutes: first.minutes, ...routeTo(demand.node, first.service.node, paths.previous) },
    serviceOptions,
  };
}

export function assessAccessibility(model: ResilienceCase, view: AccessView, signal?: AbortSignal) {
  const period = model.periods.find(item => item.id === view.periodId);
  const state = model.states.find(item => item.id === view.stateId);
  const plan = model.plans.find(item => item.id === view.planId);
  const demands = sorted(model.demands).filter(item => view.demandId === undefined || item.id === view.demandId);
  if (!period || (view.stateId && !state) || (view.planId && !plan) || !demands.length) {
    throw new Error('Use known period, state, plan and demand cohort IDs for accessibility.');
  }
  const baseline = networkSlice(model);
  const selected = state || plan ? networkSlice(model, state?.periods[period.id], plan?.periods[period.id]) : baseline;
  const baselineCache = new Map<string, ReturnType<typeof shortestPaths>>();
  const selectedCache = selected === baseline ? baselineCache : new Map<string, ReturnType<typeof shortestPaths>>();
  const coordinates = new Map(model.nodes.map(node => [node.id, node.coordinates]));
  const rows = demands.map(demand => {
    signal?.throwIfAborted();
    const reference = accessFor(demand, baseline, baselineCache);
    const result = selected === baseline ? reference : accessFor(demand, selected, selectedCache);
    const oldRoute = reference.nearest, newRoute = result.nearest;
    const sameDestination = oldRoute !== null && newRoute !== null && oldRoute.serviceId === newRoute.serviceId;
    return {
      demandId: demand.id, originId: demand.node, mode: demand.mode, kind: demand.kind, priority: demand.priority,
      demand: demand.amount * period.weight, thresholdMinutes: demand.maxMinutes, baseline: reference, selected: result,
      nearestServiceDeltaMinutes: oldRoute && newRoute ? newRoute.minutes - oldRoute.minutes : null,
      sameDestinationDetourMinutes: sameDestination ? newRoute.minutes - oldRoute.minutes : null,
    };
  });
  const accessLoss = rows.filter(row => row.baseline.status === 'within-threshold' && row.selected.status !== 'within-threshold');
  const map = {
    type: 'FeatureCollection',
    features: rows.flatMap(row => {
      const route = row.selected.nearest;
      if (!route || route.nodeIds.length < 2) return [];
      return [{
        type: 'Feature', geometry: { type: 'LineString', coordinates: route.nodeIds.map(id => coordinates.get(id)!) },
        properties: { demand_id: row.demandId, service_id: route.serviceId, mode: row.mode, minutes: route.minutes, status: row.selected.status },
      }];
    }),
  };
  return {
    view, provider: { id: 'transportx-local-directed-graph', priorityQueue: 'tinyqueue@3.0.0' },
    assumptions: [
      'Shortest paths apply the case link directions, mode restrictions, travel times and the selected slice closures.',
      'A route can be physically possible when the destination has zero model capacity. The pressure test allocates competing demand.',
      'A same-destination detour compares the nearest service only when its identity stays the same.',
    ],
    summary: {
      cohorts: rows.length, accessLostCohorts: accessLoss.length, accessLostDemand: accessLoss.reduce((sum, row) => sum + row.demand, 0),
      withinThresholdDemand: rows.filter(row => row.selected.status === 'within-threshold').reduce((sum, row) => sum + row.demand, 0),
    },
    rows, map,
  };
}
