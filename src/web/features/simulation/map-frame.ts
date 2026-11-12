import type { SimulationFrame, SimulationGeometry } from '../../../contracts/simulation';

const nodeStates = { waiting: '候车', walking: '步行接续', connecting: '待接续' } as const;
type Marker = { id: string; kind: 'bus' | 'car' | 'ridehail' | 'people' | 'metro'; position: [number, number]; count?: number; heading?: number; people?: string[] };

export function roadSpeedSamples(frame: SimulationFrame, geometry: SimulationGeometry) {
  const edges = new Set(geometry.features.flatMap(({ properties }) =>
    properties.edgeId && !properties.networkType?.startsWith('railway.') ? [properties.edgeId] : []));
  const samples = new Map<string, { totalMetersPerSecond: number; vehicleIds: string[] }>();
  for (const [id, vehicle] of Object.entries(frame.vehicles)) {
    if (vehicle.mode === 'metro' || !edges.has(vehicle.edge) || !Number.isFinite(vehicle.speed) || vehicle.speed < 0) continue;
    const sample = samples.get(vehicle.edge) ?? { totalMetersPerSecond: 0, vehicleIds: [] };
    sample.totalMetersPerSecond += vehicle.speed;
    sample.vehicleIds.push(id);
    samples.set(vehicle.edge, sample);
  }
  return samples;
}

export function projectMapFrame(frame: SimulationFrame, geometry: SimulationGeometry) {
  const markers: Marker[] = [], features = [];
  let cars = 0, ridehail = 0, buses = 0, metroRiders = 0;
  for (const [id, vehicle] of Object.entries(frame.vehicles)) {
    if (!vehicle.positionGeo) continue;
    const fleet = frame.fleet?.[id];
    // Version 1 frames lack fleet mode and use fixed IDs.
    const kind = vehicle.mode === 'metro' ? 'metro' : fleet?.mode === 'bus' || !fleet?.mode && id === 'bus-0' ? 'bus'
      : fleet?.mode === 'ridehail' || !fleet?.mode && id === 'car-0' ? 'ridehail'
      : /^road-\d+$/.test(id) ? 'car' : 'vehicle';
    if (kind === 'bus') buses++;
    if (kind === 'ridehail') ridehail++;
    if (kind === 'car') cars++;
    if (kind !== 'vehicle') markers.push({ id, kind, position: vehicle.positionGeo, count: fleet?.occupants.length, heading: vehicle.heading });
    features.push({ type: 'Feature' as const, id, properties: { id, kind }, geometry: { type: 'Point' as const, coordinates: vehicle.positionGeo } });
  }
  const peopleByNode = new Map<string, { waiting: number; walking: number; connecting: number }>();
  for (const person of Object.values(frame.travelers ?? {})) {
    if (person.state === 'external' && (person.metroBoardedAt !== undefined || 'mode' in person && person.mode === 'bus')) metroRiders++;
    const { state, location } = person;
    if (!location || state !== 'waiting' && state !== 'walking' && state !== 'connecting') continue;
    const id = location.startsWith('node:') ? location : `node:${location}`;
    const counts = peopleByNode.get(id) ?? { waiting: 0, walking: 0, connecting: 0 };
    counts[state]++;
    peopleByNode.set(id, counts);
  }
  for (const feature of geometry.features) {
    if (!feature.properties.nodeId || feature.geometry.type !== 'Point') continue;
    const counts = peopleByNode.get(feature.properties.nodeId);
    if (!counts) continue;
    const people = (Object.keys(counts) as Array<keyof typeof counts>).flatMap(state => counts[state] ? [`${nodeStates[state]} ${counts[state]}`] : []);
    markers.push({ id: feature.properties.nodeId, kind: 'people', position: feature.geometry.coordinates,
      count: counts.waiting + counts.walking + counts.connecting, people });
  }
  return { markers, vehicles: { type: 'FeatureCollection' as const, features }, cars, ridehail, buses, metroRiders };
}
