// Development probe adapter; production IO and validation use the same compiled authorities.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const io = require('../../bin/simulation-job.js');
const { parseSimulationConfiguration } = require('../../bin/contracts/simulation.js');
export const sha256 = io.simulationDigest;
export const readJson = io.readSimulationJson;
export const readIndex = io.readSimulationIndex;
export const readChunk = io.readSimulationChunk;
export const readPublished = io.readSimulationPublished;
export const verifyResult = io.verifySimulationResult;
export function validateScenario(value) {
  const parsed = parseSimulationConfiguration(value);
  if (!parsed) throw new Error('simulation_configuration_invalid');
  return structuredClone(parsed);
}
export function createJob(request, trusted) {
  const implementationRoot = fileURLToPath(new URL('../../modules/optional/traffic-simulation/scripts', import.meta.url));
  return io.createSimulationJob(request, { ...trusted, implementationRoot, implementationVersion: readJson(path.join(implementationRoot, '..', 'manifest.json')).version,
    mapping: { version: 1, roadRoute: ['hub', 'out', 'relay', 'back'], ...(request.model === 'evacuation' ? { edges: { hub: 'hub', outbound: 'out', relay: 'relay', inbound: 'back' } } : {}) },
    provenance: { kind: 'synthetic', description: 'P0/P1 technical probe', validDate: request.serviceDate, modelValidation: 'not_calibrated' },
  });
}
