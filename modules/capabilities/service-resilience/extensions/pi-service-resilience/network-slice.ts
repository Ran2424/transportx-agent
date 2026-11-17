import TinyQueue from 'tinyqueue';
import type { NetworkChange, ResilienceCase } from './model.ts';

export const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id, 'en'));

export function networkSlice(model: ResilienceCase, state: NetworkChange = {}, plan: NetworkChange = {}) {
  const closedEdges = new Set([...(state.closedEdges ?? []), ...(plan.closedEdges ?? [])]);
  const closedServices = new Set([...(state.closedServices ?? []), ...(plan.closedServices ?? [])]);
  const unavailable = new Set([...(state.unavailableResources ?? []), ...(plan.unavailableResources ?? [])]);
  const usable = (requires: string[]) => requires.every(resource => !unavailable.has(resource));
  const edges = sorted(model.edges).filter(edge => !closedEdges.has(edge.id) && usable(edge.requires)).map(edge => {
    const stateTime = state.edgeMinutes?.[edge.id], planTime = plan.edgeMinutes?.[edge.id];
    const minutes = stateTime !== undefined && planTime !== undefined ? Math.max(stateTime, planTime) : planTime ?? stateTime ?? edge.minutes;
    return { ...edge, minutes };
  });
  const services = sorted(model.services).filter(service => !closedServices.has(service.id) && usable(service.requires)).map(service => {
    const stateCapacity = state.serviceCapacity?.[service.id], planCapacity = plan.serviceCapacity?.[service.id];
    const capacity = stateCapacity !== undefined && planCapacity !== undefined
      ? Math.min(stateCapacity, planCapacity) : planCapacity ?? stateCapacity ?? service.capacity;
    return { ...service, capacity };
  });
  const outgoing = new Map<string, typeof edges>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  return { edges, services, outgoing };
}

type Visit = { node: string; minutes: number };

export function shortestPaths(slice: ReturnType<typeof networkSlice>, origin: string, mode: string, limit = Infinity) {
  const distances = new Map([[origin, 0]]);
  const previous = new Map<string, { node: string; edgeId: string }>();
  const queue = new TinyQueue<Visit>([{ node: origin, minutes: 0 }], (a, b) =>
    a.minutes - b.minutes || (a.node < b.node ? -1 : Number(a.node > b.node)));
  while (queue.length) {
    const { node, minutes } = queue.pop()!;
    if (minutes !== distances.get(node)) continue;
    if (minutes > limit) break;
    for (const edge of slice.outgoing.get(node) ?? []) {
      if (!edge.modes.includes(mode)) continue;
      const next = minutes + edge.minutes;
      if (next >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, next);
      previous.set(edge.to, { node, edgeId: edge.id });
      queue.push({ node: edge.to, minutes: next });
    }
  }
  return { distances, previous };
}

export function routeTo(origin: string, destination: string, previous: ReturnType<typeof shortestPaths>['previous']) {
  const nodes = [destination];
  const edges: string[] = [];
  for (let node = destination; node !== origin;) {
    const step = previous.get(node);
    if (!step) throw new Error('Destination has no route from the specified origin.');
    edges.push(step.edgeId);
    node = step.node;
    nodes.push(node);
  }
  return { nodeIds: nodes.reverse(), edgeIds: edges.reverse() };
}
