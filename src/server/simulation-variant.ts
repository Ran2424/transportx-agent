import { isDeepStrictEqual } from 'node:util';
import type { ScenarioVariant, TrafficScenario } from '../contracts/simulation.js';
import type { GeoClientContextV1 } from '../contracts/geo-interaction.js';
import { readSimulationJson } from './simulation-job.js';

export type ScenarioRecord = { schemaVersion: 1; scenarioId: string; owner: string; moduleVersion: string; document: TrafficScenario; networkSha256: string; geometrySha256: string; variant?: ScenarioVariant; inputContextSha256?: string };
export const fail = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });

export function resolveSimulationVariant(body: { parentScenarioId?: unknown; interventions?: unknown }, document: TrafficScenario, networkSha256: string, inputContext: GeoClientContextV1 | undefined, loadParent: (id: string) => ScenarioRecord, contextFile: (id: string) => string) {
  const config = document.configuration;
  if (body.parentScenarioId !== undefined) {
    if (typeof body.parentScenarioId !== 'string' || !Array.isArray(body.interventions) || !body.interventions.length || body.interventions.length > 2 || new Set(body.interventions).size !== body.interventions.length || body.interventions.some(field => !['departures', 'policy', 'railTimetable'].includes(field)) || body.interventions.includes('railTimetable') && body.interventions.length !== 1) throw fail('traffic_variant_invalid', 'Declare the parent and exact changed service fields.', 400);
    const parent = loadParent(body.parentScenarioId);
    if (parent.inputContextSha256) {
      const frozen = readSimulationJson<GeoClientContextV1>(contextFile(parent.scenarioId));
      if (inputContext && !isDeepStrictEqual(inputContext, frozen)) throw fail('traffic_variant_incomparable', 'Variant Geo selection must equal its frozen parent.');
      inputContext = frozen;
    } else if (inputContext) throw fail('traffic_variant_incomparable', 'Do not add a different selection to a variant.');
    const expected = structuredClone(parent.document.configuration), actual = structuredClone(config);
    if (expected.model !== 'multimodal' || actual.model !== 'multimodal' || networkSha256 !== parent.networkSha256 || !isDeepStrictEqual(document.network.mapping, parent.document.network.mapping) || !isDeepStrictEqual(document.provenance, parent.document.provenance)) throw fail('traffic_variant_incomparable', 'Variants require the same frozen network, demand source and model.');
    for (const field of body.interventions as ScenarioVariant['interventions']) {
      if (field === 'railTimetable') {
        if (!expected.rail || !actual.rail || expected.rail.stops.length !== actual.rail.stops.length) throw fail('traffic_variant_incomparable', 'Choose the same physical metro service.');
        if (isDeepStrictEqual(expected.rail, actual.rail)) throw fail('traffic_variant_unchanged', 'Adjust a timetable value.');
        actual.rail.insertTime = expected.rail.insertTime;
        for (const [i, stop] of actual.rail.stops.entries()) {
          const { arrival, departure, minDwell } = expected.rail.stops[i];
          Object.assign(stop, { arrival, departure, minDwell });
        }
        actual.coordination!.metro[0].time = expected.coordination!.metro[0].time;
        continue;
      }
      if (isDeepStrictEqual(actual.coordination![field], expected.coordination![field])) throw fail('traffic_variant_unchanged', 'Each declared intervention must change its named input.');
      Object.assign(actual.coordination!, { [field]: expected.coordination![field] });
    }
    if (!isDeepStrictEqual(expected, actual)) throw fail('traffic_variant_incomparable', 'Demand, fleet, nodes, routes, dates, units and other common conditions must remain identical.');
    const variant: ScenarioVariant = { parentScenarioId: body.parentScenarioId, interventions: body.interventions as ScenarioVariant['interventions'] };
    return { variant, inputContext };
  } else if (body.interventions !== undefined) throw fail('traffic_variant_invalid', 'Interventions require a frozen parent.', 400);
  return { variant: undefined, inputContext };
}
