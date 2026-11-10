import { asRecord } from './common.ts';

export type ServiceNode = { id: string; role: 'pickup' | 'transfer'; edge: string; waitingCapacity: number; berths: Array<{ lane: number; position: number }> };
export type ServiceRoute = { id: string; mode: 'bus' | 'ridehail'; origin: string; target: string; destination: string; outbound: string[]; inbound: string[]; transferSeconds: number; externalSeconds: number };
export type FleetVehicle = { id: string; mode: 'bus' | 'ridehail'; capacity: number; home: string; berth: number };
export type MultimodalTraveler = { id: string; time: number; origin: string; destination: string; route: string };
export type MultimodalService = {
  version: 2; nodes: ServiceNode[]; routes: ServiceRoute[]; fleet: FleetVehicle[];
  boardingSeconds: number; travelers: MultimodalTraveler[];
  departures: Array<{ id: string; time: number; vehicle: string; route: string }>;
  metro: Array<{ id: string; time: number; node: string; destination: string; capacity: number; externalSeconds: number }>;
  policy: { kind: 'fixed' } | { kind: 'queue-threshold'; threshold: number; cooldownSeconds: number; routes: string[] };
};
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const exact = (value: unknown, fields: string[]) => !!asRecord(value) && Object.keys(value as object).sort().join() === [...fields].sort().join();
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9:-]{0,119}$/.test(value) && !value.startsWith('road-') && !value.startsWith('feedback-');
const edge = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const rows = (value: unknown, max: number, min = 1): value is Record<string, unknown>[] => Array.isArray(value) && value.length >= min && value.length <= max && value.every(item => !!asRecord(item));

/** Explicit finite service model; no policy code or untyped configuration bags. */
export function parseMultimodalService(input: unknown): MultimodalService | null {
  const value = asRecord(input);
  if (!value || !exact(value, ['version', 'nodes', 'routes', 'fleet', 'boardingSeconds', 'travelers', 'departures', 'metro', 'policy']) || value.version !== 2 || !integer(value.boardingSeconds, 1, 60)) return null;
  if (!rows(value.nodes, 8) || !rows(value.routes, 8) || !rows(value.fleet, 8) || !rows(value.travelers, 100) || !rows(value.departures, 32, 0) || !rows(value.metro, 16, 0)) return null;
  const trains = value.metro;
  const ids = new Set<string>();
  for (const group of [value.nodes, value.routes, value.fleet, value.travelers, value.departures, value.metro]) for (const item of group) {
    if (!id(item.id) || ids.has(item.id)) return null;
    ids.add(item.id);
  }
  const nodes = new Map(value.nodes.map(node => [node.id, node]));
  for (const node of value.nodes) {
    if (!exact(node, ['id', 'role', 'edge', 'waitingCapacity', 'berths']) || !String(node.id).startsWith('node:') || !['pickup', 'transfer'].includes(String(node.role)) || !edge(node.edge) || !integer(node.waitingCapacity, 1, 100) || !rows(node.berths, 4)) return null;
    const positions = new Set<string>();
    for (const berth of node.berths) {
      if (!exact(berth, ['lane', 'position']) || !integer(berth.lane, 0, 3) || typeof berth.position !== 'number' || !Number.isFinite(berth.position) || berth.position < 10 || berth.position > 10000 || positions.has(`${berth.lane}:${berth.position}`)) return null;
      positions.add(`${berth.lane}:${berth.position}`);
    }
  }
  const routes = new Map(value.routes.map(route => [route.id, route]));
  for (const route of value.routes) {
    if (!exact(route, ['id', 'mode', 'origin', 'target', 'destination', 'outbound', 'inbound', 'transferSeconds', 'externalSeconds']) || !String(route.id).startsWith('route:') || route.id === 'route:road' || !['bus', 'ridehail'].includes(String(route.mode)) || nodes.get(route.origin)?.role !== 'pickup' || nodes.get(route.target)?.role !== 'transfer' || !id(route.destination) || !integer(route.transferSeconds, 0, 300) || !integer(route.externalSeconds, 1, 3600)) return null;
    for (const [key, first, last] of [['outbound', route.origin, route.target], ['inbound', route.target, route.origin]] as const) {
      const edges = route[key];
      if (!Array.isArray(edges) || edges.length < 2 || edges.length > 32 || edges.some(item => !edge(item)) || edges[0] !== nodes.get(first)?.edge || edges.at(-1) !== nodes.get(last)?.edge) return null;
    }
  }
  const fleet = new Map(value.fleet.map(vehicle => [vehicle.id, vehicle]));
  const occupied = new Set<string>();
  for (const vehicle of value.fleet) {
    const home = nodes.get(vehicle.home), berth = `${vehicle.home}:${vehicle.berth}`;
    if (!exact(vehicle, ['id', 'mode', 'capacity', 'home', 'berth']) || !['bus', 'ridehail'].includes(String(vehicle.mode)) || !integer(vehicle.capacity, 1, 40) || vehicle.mode === 'ridehail' && vehicle.capacity !== 1 || home?.role !== 'pickup' || !integer(vehicle.berth, 0, (home.berths as unknown[]).length - 1) || occupied.has(berth) || !value.routes.some(route => route.origin === vehicle.home && route.mode === vehicle.mode)) return null;
    occupied.add(berth);
  }
  for (const traveler of value.travelers) {
    const route = routes.get(traveler.route);
    if (!exact(traveler, ['id', 'time', 'origin', 'destination', 'route']) || !integer(traveler.time, 0, 7200) || !route || traveler.origin !== route.origin || traveler.destination !== route.destination) return null;
  }
  for (const departure of value.departures) {
    const route = routes.get(departure.route), vehicle = fleet.get(departure.vehicle);
    if (!exact(departure, ['id', 'time', 'vehicle', 'route']) || !integer(departure.time, 0, 7200) || !route || !vehicle || route.origin !== vehicle.home || route.mode !== vehicle.mode) return null;
  }
  for (const train of value.metro) if (!exact(train, ['id', 'time', 'node', 'destination', 'capacity', 'externalSeconds']) || !integer(train.time, 0, 7200) || !integer(train.capacity, 1, 100) || !integer(train.externalSeconds, 1, 3600) || nodes.get(train.node)?.role !== 'transfer' || !value.routes.some(route => route.mode === 'bus' && route.target === train.node && route.destination === train.destination)) return null;
  const policy = asRecord(value.policy);
  if (!policy || !(policy.kind === 'fixed' && exact(policy, ['kind']) || policy.kind === 'queue-threshold' && exact(policy, ['kind', 'threshold', 'cooldownSeconds', 'routes']) && integer(policy.threshold, 1, 100) && integer(policy.cooldownSeconds, 1, 600) && Array.isArray(policy.routes) && policy.routes.length > 0 && policy.routes.length <= 8 && new Set(policy.routes).size === policy.routes.length && policy.routes.every(route => routes.get(route)?.mode === 'bus'))) return null;
  if (value.routes.some(route => route.mode === 'bus' && !trains.some(train => train.node === route.target && train.destination === route.destination))) return null;
  return value as unknown as MultimodalService;
}
