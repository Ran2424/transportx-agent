import { Type as T, type Static } from 'typebox';
import { Value } from 'typebox/value';

const fields = { additionalProperties: false };
const id = T.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$' });
const label = T.String({ minLength: 1, maxLength: 200 });
const ids = (maxItems: number, minItems = 0) => T.Array(id, { maxItems, minItems, uniqueItems: true });
const minutes = T.Number({ exclusiveMinimum: 0, maximum: 1440 });
const capacity = T.Integer({ minimum: 0, maximum: 1_000_000 });
const change = T.Object({
  closedEdges: T.Optional(ids(4000)),
  closedServices: T.Optional(ids(100)),
  unavailableResources: T.Optional(ids(4000)),
  edgeMinutes: T.Optional(T.Record(id, minutes, { maxProperties: 4000 })),
  serviceCapacity: T.Optional(T.Record(id, capacity, { maxProperties: 100 })),
}, fields);
const variant = T.Object({ id, label, periods: T.Record(id, change, { maxProperties: 12 }) }, fields);
const node = T.Object({
  id, coordinates: T.Tuple([T.Number({ minimum: -180, maximum: 180 }), T.Number({ minimum: -90, maximum: 90 })]),
}, fields);
const edge = T.Object({ id, from: id, to: id, minutes, modes: ids(8, 1), requires: ids(12) }, fields);

export const NetworkSchema = T.Object({ nodes: T.Array(node, { minItems: 2, maxItems: 4000 }), edges: T.Array(edge, { minItems: 1, maxItems: 10000 }) }, fields);
const CaseSchema = T.Object({
  ...NetworkSchema.properties,
  title: label,
  provenance: T.Object({ kind: T.Union([T.Literal('exercise'), T.Literal('observations')]), note: T.String({ minLength: 1, maxLength: 1800 }) }, fields),
  networkEvidence: T.Optional(T.Object({
    path: T.String({ minLength: 1, maxLength: 500 }),
    sha256: T.String({ pattern: '^[a-f0-9]{64}$' }),
    notes: T.Array(T.String({ maxLength: 500 }), { maxItems: 12 }),
  }, fields)),
  services: T.Array(T.Object({ id, node: id, kind: id, capacity, requires: ids(12) }, fields), { minItems: 1, maxItems: 100 }),
  demands: T.Array(T.Object({ id, node: id, kind: id, mode: id, amount: T.Integer({ minimum: 1, maximum: 1_000_000 }),
    priority: T.Boolean(), maxMinutes: minutes }, fields), { minItems: 1, maxItems: 160 }),
  periods: T.Array(T.Object({ id, label, weight: T.Integer({ minimum: 1, maximum: 1000 }) }, fields), { minItems: 1, maxItems: 12 }),
  states: T.Array(variant, { minItems: 1, maxItems: 16 }),
  plans: T.Array(T.Object({ ...variant.properties, setupMinutes: T.Optional(T.Integer({ minimum: 0, maximum: 10080 })) }, fields), { minItems: 2, maxItems: 8 }),
  investigations: T.Array(T.Object({ id, question: label, source: label, effort: label,
    leadMinutes: T.Integer({ minimum: 0, maximum: 10080 }),
    outcomes: T.Array(T.Object({ label, stateIds: ids(16, 1) }, fields), { minItems: 1, maxItems: 16 }),
  }, fields), { maxItems: 20 }),
  decisionWindowMinutes: T.Integer({ minimum: 0, maximum: 10080 }),
}, fields);

export type ResilienceCase = Static<typeof CaseSchema>;
export type NetworkChange = Static<typeof change>;
const ObservationSchema = T.Object({ id, objectId: id, periodId: id,
  value: T.String({ minLength: 1, maxLength: 2000 }), source: T.String({ minLength: 1, maxLength: 500 }) }, fields);
export type Observation = Static<typeof ObservationSchema>;

export function parseNetwork(value: unknown) {
  if (!Value.Check(NetworkSchema, value)) throw new Error('Invalid resilience network; provide bounded WGS84 nodes and directed edges.');
  return value;
}

export function parseObservations(value: unknown): Observation[] {
  const schema = T.Array(ObservationSchema, { minItems: 1, maxItems: 5000 });
  if (!Value.Check(schema, value)) throw new Error('Invalid observations. Each row needs observation, object and period IDs, a value and its source.');
  idsOf(value, 'observations');
  if (value.some(item => !item.value.trim() || !item.source.trim())) throw new Error('Observation value and source must not be blank.');
  return value;
}

function idsOf(items: { id: string }[], kind: string) {
  const known = new Set(items.map(item => item.id));
  if (known.size !== items.length) throw new Error('Duplicate IDs in ' + kind);
  if (items.some(item => item.id in Object.prototype || item.id === 'prototype')) throw new Error('Reserved ID in ' + kind);
  return known;
}

function requireKnown(values: Iterable<string>, known: Set<string>, kind: string) {
  for (const value of values) if (!known.has(value)) throw new Error(`Unknown ${kind} ID: ${value}`);
}

export function parseCase(value: unknown): ResilienceCase {
  if (!Value.Check(CaseSchema, value)) {
    const first = Value.Errors(CaseSchema, value)[0];
    const location = first?.instancePath || '';
    throw new Error('Invalid resilience case' + (location ? ' at ' + location : '') + '. See the module case schema.');
  }
  const { nodes, edges, services, demands, periods, states, plans, investigations } = value;
  const variants = 1 + states.length * (1 + plans.length);
  const slices = variants * periods.length;
  if (slices > 256 || slices * demands.length * (edges.length + nodes.length) > 24_000_000 ||
      slices * demands.length * services.length > 180_000) {
    throw new Error('Case workload exceeds the interactive limit. Reduce states, plans, periods, cohorts or network size.');
  }
  const nodeIds = idsOf(nodes, 'nodes'), edgeIds = idsOf(edges, 'edges'), serviceIds = idsOf(services, 'services');
  const periodIds = idsOf(periods, 'periods'), stateIds = idsOf(states, 'states');
  idsOf(plans, 'plans');
  idsOf(investigations, 'investigations');
  idsOf([...nodes, ...edges, ...services, ...demands], 'network and service objects');
  requireKnown(edges.flatMap(item => [item.from, item.to]), nodeIds, 'edge endpoint');
  if (edges.some(item => item.from === item.to)) throw new Error('Network edges must connect distinct nodes.');
  requireKnown([...services, ...demands].map(item => item.node), nodeIds, 'service or demand node');
  requireKnown(demands.map(item => item.kind), new Set(services.map(item => item.kind)), 'service kind');
  requireKnown(demands.map(item => item.mode), new Set(edges.flatMap(item => item.modes)), 'travel mode');
  const resources = new Set([...edges, ...services].flatMap(item => item.requires));
  for (const variant of [...states, ...plans]) {
    requireKnown(Object.keys(variant.periods), periodIds, 'period');
    for (const change of Object.values(variant.periods)) {
      requireKnown([...(change.closedEdges || []), ...Object.keys(change.edgeMinutes || {})], edgeIds, 'edge');
      requireKnown(Object.keys(change.serviceCapacity || {}), serviceIds, 'service');
      requireKnown(change.closedServices || [], serviceIds, 'service');
      requireKnown(change.unavailableResources || [], resources, 'shared resource');
    }
  }
  for (const observation of investigations) {
    const possible = observation.outcomes.flatMap(item => item.stateIds);
    requireKnown(possible, stateIds, 'state');
    if (new Set(possible).size !== stateIds.size || new Set(observation.outcomes.map(item => item.label)).size !== observation.outcomes.length) {
      throw new Error(`Investigation ${observation.id} must have distinct outcome labels and cover every state.`);
    }
  }
  return value;
}
