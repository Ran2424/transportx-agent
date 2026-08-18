const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import type { JsonRecord } from './types.js';
import type { PiRpcSession } from './sessions.js';
import { PythonRunner } from './python-runner.js';
import { diagnosticMessage, parseSpatialAnalysisResultStructured, type SpatialAnalysisResultV1 } from '../contracts/index.js';
import { sha256File, within } from './asset-integrity.js';

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_FEATURES = 50_000;

function requiredString(body: JsonRecord, key: string, max = 1000) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value || value.length > max) throw new Error(`${key} is required`);
  return value;
}

function optionalFields(body: JsonRecord) {
  if (body.rightFields === undefined) return [];
  if (!Array.isArray(body.rightFields) || body.rightFields.length > 20 || body.rightFields.some((item) => typeof item !== 'string' || !item.trim() || item.length > 120)) throw new Error('rightFields must contain at most 20 property names');
  return body.rightFields;
}

function safeInput(cwd: string, relativePath: string) {
  if (path.isAbsolute(relativePath) || !/\.geojson$/i.test(relativePath)) throw new Error('Spatial inputs must be relative .geojson paths');
  const root = fs.realpathSync(cwd);
  const parts = relativePath.split(/[\\/]+/);
  let cursor = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new Error(`Unsafe spatial input path: ${relativePath}`);
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Spatial inputs cannot use symbolic links: ${relativePath}`);
  }
  const resolved = fs.realpathSync(path.resolve(root, relativePath));
  if (!within(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Spatial input escapes the session: ${relativePath}`);
  if (fs.statSync(resolved).size > MAX_INPUT_BYTES) throw new Error(`Spatial input exceeds 100 MiB: ${relativePath}`);
  const geojson = JSON.parse(fs.readFileSync(resolved, 'utf8')) as { type?: unknown; features?: unknown };
  if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) throw new Error(`Spatial input must be a GeoJSON FeatureCollection: ${relativePath}`);
  if (geojson.features.length > MAX_FEATURES) throw new Error(`Spatial input exceeds 50,000 features: ${relativePath}`);
  return { absolutePath: resolved, relativePath: path.relative(root, resolved).split(path.sep).join('/'), sha256: sha256File(resolved), featureCount: geojson.features.length };
}

export class SpatialAnalysisService {
  private runner: PythonRunner;
  constructor(executable: ConstructorParameters<typeof PythonRunner>[0], private scriptPath: string) {
    this.runner = new PythonRunner(executable);
  }

  async analyze(session: PiRpcSession, body: JsonRecord): Promise<SpatialAnalysisResultV1> {
    const operation = requiredString(body, 'operation', 40);
    if (operation !== 'buffer' && operation !== 'nearest' && operation !== 'spatial_join') throw new Error('Unsupported spatial operation');
    const analysisId = `spatial_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    const resultRelativePath = `analysis/spatial/${analysisId}/result.geojson`;
    const manifestRelativePath = `.tau/spatial-results/${analysisId}/manifest.json`;
    const resultPath = path.join(session.cwd, resultRelativePath);
    const manifestPath = path.join(session.cwd, manifestRelativePath);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

    const inputs: JsonRecord[] = [];
    const parameters: JsonRecord = { repairInvalid: body.repairInvalid === true };
    if (operation === 'buffer') {
      const input = safeInput(session.cwd, requiredString(body, 'inputPath'));
      const distanceMeters = typeof body.distanceMeters === 'number' && Number.isFinite(body.distanceMeters) && body.distanceMeters > 0 ? body.distanceMeters : null;
      const inputCrs = requiredString(body, 'inputCrs', 120); const metricCrs = requiredString(body, 'metricCrs', 120);
      if (!distanceMeters) throw new Error('distanceMeters must be positive');
      if (metricCrs.toUpperCase() === 'EPSG:4326') throw new Error('metricCrs cannot be EPSG:4326 for distance operations');
      inputs.push({ role: 'input', ...input, crs: inputCrs });
      Object.assign(parameters, { distanceMeters, inputCrs, metricCrs, dissolve: body.dissolve === true });
    } else {
      const left = safeInput(session.cwd, requiredString(body, 'leftPath')); const right = safeInput(session.cwd, requiredString(body, 'rightPath'));
      const leftCrs = requiredString(body, 'leftCrs', 120); const rightCrs = requiredString(body, 'rightCrs', 120);
      inputs.push({ role: 'left', ...left, crs: leftCrs }, { role: 'right', ...right, crs: rightCrs });
      Object.assign(parameters, { leftCrs, rightCrs });
      if (operation === 'nearest') {
        const metricCrs = requiredString(body, 'metricCrs', 120);
        if (metricCrs.toUpperCase() === 'EPSG:4326') throw new Error('metricCrs cannot be EPSG:4326 for distance operations');
        if (body.maxDistanceMeters !== undefined && (typeof body.maxDistanceMeters !== 'number' || !Number.isFinite(body.maxDistanceMeters) || body.maxDistanceMeters <= 0)) throw new Error('maxDistanceMeters must be positive');
        Object.assign(parameters, { metricCrs, ...(body.maxDistanceMeters === undefined ? {} : { maxDistanceMeters: body.maxDistanceMeters as number }) });
      } else {
        const predicate = body.predicate; const cardinality = body.cardinality;
        if (predicate !== 'intersects' && predicate !== 'within' && predicate !== 'contains') throw new Error('predicate must be intersects, within or contains');
        if (cardinality !== 'one-to-one' && cardinality !== 'one-to-many') throw new Error('cardinality must be one-to-one or one-to-many');
        const multipleMatchStrategy = body.multipleMatchStrategy === undefined ? 'error' : body.multipleMatchStrategy;
        if (multipleMatchStrategy !== 'error' && multipleMatchStrategy !== 'first') throw new Error('multipleMatchStrategy must be error or first');
        Object.assign(parameters, { predicate, cardinality, multipleMatchStrategy });
      }
      const rightFields = optionalFields(body);
      if (rightFields.length) parameters.rightFields = rightFields.join(',');
    }

    const requestPath = path.join(path.dirname(manifestPath), 'request.json');
    fs.writeFileSync(requestPath, `${JSON.stringify({ analysisId, operation, inputs, parameters, resultPath, resultRelativePath }, null, 2)}\n`);
    try {
      const { stdout } = await this.runner.run(this.scriptPath, ['--request', requestPath], { cwd: session.cwd, timeoutMs: 120_000 });
      const parsed = parseSpatialAnalysisResultStructured(JSON.parse(stdout));
      if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnosticMessage).join('; '));
      const result = parsed.value;
      if (result.analysisId !== analysisId || result.output.relativePath !== resultRelativePath) throw new Error('Spatial runner returned an unexpected output path');
      if (!fs.existsSync(resultPath) || fs.statSync(resultPath).size > MAX_INPUT_BYTES || sha256File(resultPath) !== result.output.sha256) throw new Error('Spatial output failed size or checksum validation');
      const output = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { type?: unknown; features?: unknown };
      if (output.type !== 'FeatureCollection' || !Array.isArray(output.features) || output.features.length !== result.output.featureCount || output.features.length > MAX_FEATURES) throw new Error('Spatial output failed GeoJSON validation');
      fs.writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
      return result;
    } catch (error) {
      fs.rmSync(manifestPath, { force: true });
      fs.rmSync(resultPath, { force: true });
      throw error;
    } finally {
      fs.rmSync(requestPath, { force: true });
    }
  }

  terminateAll() { this.runner.terminateAll(); }
}
