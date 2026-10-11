import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWithin } from './util/path.js';

export function readVerifiedGeoResource(cwd: string, resourceId: string) {
  const reject = (message: string, status: number) => { throw Object.assign(new Error(message), { status, code: status === 409 ? 'resource_changed' : 'geo_resource_invalid' }); };
  if (!/^geo_[a-f0-9]{16,64}$/.test(resourceId)) reject('Invalid geo resource id', 400);
  const session = fs.realpathSync(cwd);
  const root = fs.realpathSync(path.join(cwd, '.tau', 'geo-resources'));
  const directory = fs.realpathSync(path.join(root, resourceId));
  const manifestFile = fs.realpathSync(path.join(directory, 'manifest.json'));
  const dataFile = fs.realpathSync(path.join(directory, 'data.geojson'));
  if (!isWithin(session, root) || !isWithin(root, directory) || !isWithin(directory, manifestFile) || !isWithin(directory, dataFile)) reject('Geo resource path is not allowed', 403);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { resourceId: string; sha256: string; bytes: number; [key: string]: unknown };
  if (manifest.resourceId !== resourceId || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0) reject('Geo resource manifest is invalid', 409);
  const stat = fs.statSync(dataFile);
  if (!stat.isFile()) reject('Geo resource is not a file', 403);
  if (stat.size > 100 * 1024 * 1024) reject('Geo resource exceeds 100 MB', 413);
  const buffer = fs.readFileSync(dataFile);
  if (buffer.length !== manifest.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== manifest.sha256) reject('Geo resource integrity check failed', 409);
  return { manifest, buffer };
}
