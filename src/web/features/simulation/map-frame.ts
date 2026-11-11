import type { SimulationFrame, SimulationGeometry } from '../../../contracts/simulation';

type Marker = { id: string; kind: 'bus' | 'people'; position: [number, number]; count: number };

export function projectMapFrame(frame: SimulationFrame, geometry: SimulationGeometry) {
  const markers: Marker[] = [], features = [];
  let cars = 0, buses = 0, metroRiders = 0;
  for (const [id, vehicle] of Object.entries(frame.vehicles)) {
    if (!vehicle.positionGeo) continue;
    const fleet = frame.fleet?.[id];
    // Version 1 frames lack fleet mode and use fixed IDs.
    if (fleet?.mode === 'bus' || !fleet?.mode && id === 'bus-0') {
      markers.push({ id, kind: 'bus', position: vehicle.positionGeo, count: fleet?.occupants.length ?? 0 });
      buses++;
    } else {
      const car = fleet?.mode === 'ridehail' || id === 'car-0' || /^road-\d+$/.test(id);
      if (car) cars++;
      features.push({ type: 'Feature' as const, id, properties: { id, car }, geometry: { type: 'Point' as const, coordinates: vehicle.positionGeo } });
    }
  }
  const peopleByNode = new Map<string, number>();
  for (const person of Object.values(frame.travelers ?? {})) {
    if (person.state === 'external' && (person.metroBoardedAt !== undefined || 'mode' in person && person.mode === 'bus')) metroRiders++;
    if (!person.location || !['waiting', 'walking', 'connecting'].includes(person.state)) continue;
    const id = person.location.startsWith('node:') ? person.location : `node:${person.location}`;
    peopleByNode.set(id, (peopleByNode.get(id) ?? 0) + 1);
  }
  for (const feature of geometry.features) {
    if (!feature.properties.nodeId || feature.geometry.type !== 'Point') continue;
    const count = peopleByNode.get(feature.properties.nodeId);
    if (count) markers.push({ id: feature.properties.nodeId, kind: 'people', position: feature.geometry.coordinates, count });
  }
  return { markers, vehicles: { type: 'FeatureCollection' as const, features }, cars, buses, metroRiders };
}
