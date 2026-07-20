const fs = require('node:fs');
const path = require('node:path');

import type { IncomingMessage, ServerResponse } from 'node:http';

type GeoResourceSession = { cwd: string };
type GeoResourceRouteDeps = { getSession(sessionId: string): GeoResourceSession | null | undefined };
type GeoResourceManifest = {
  resourceId?: string;
  sha256?: string;
  bytes?: number;
  [key: string]: unknown;
};

const RESOURCE_ID_RE = /^geo_[a-f0-9]{16,64}$/;
const GEO_RESOURCE_ROUTE_RE = /^\/api\/live-sessions\/([^/]+)\/geo-resources\/([^/]+)\/(manifest|data)$/;

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function handleGeoResourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  cleanPath: string,
  deps: GeoResourceRouteDeps,
) {
  const match = cleanPath.match(GEO_RESOURCE_ROUTE_RE);
  if (!match || req.method !== 'GET') return false;
  let sessionId: string;
  let resourceId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    resourceId = decodeURIComponent(match[2]);
  } catch {
    sendJson(res, 400, { error: 'Malformed geo resource URL' });
    return true;
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Live session not found' });
    return true;
  }
  serveGeoResource(req, res, session, resourceId, match[3] as 'manifest' | 'data');
  return true;
}

export function serveGeoResource(req: IncomingMessage, res: ServerResponse, session: GeoResourceSession, resourceId: string, part: 'manifest' | 'data') {
  if (!RESOURCE_ID_RE.test(resourceId)) return sendJson(res, 400, { error: 'Invalid geo resource id' });
  const root = path.resolve(session.cwd, '.tau', 'geo-resources');
  const resourceDir = path.resolve(root, resourceId);
  if (!within(root, resourceDir)) return sendJson(res, 403, { error: 'Geo resource is outside the active task' });
  const manifestPath = path.join(resourceDir, 'manifest.json');
  const dataPath = path.join(resourceDir, 'data.geojson');
  try {
    const realRoot = fs.realpathSync(root);
    const realResourceDir = fs.realpathSync(resourceDir);
    const realManifest = fs.realpathSync(manifestPath);
    const realData = fs.realpathSync(dataPath);
    if (!within(realRoot, realResourceDir) || !within(realResourceDir, realManifest) || !within(realResourceDir, realData)) {
      return sendJson(res, 403, { error: 'Geo resource path is not allowed' });
    }
    const manifest = JSON.parse(fs.readFileSync(realManifest, 'utf8')) as GeoResourceManifest;
    const stat = fs.statSync(realData);
    if (manifest.resourceId !== resourceId || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
      return sendJson(res, 409, { error: 'Geo resource manifest is invalid' });
    }
    if (typeof manifest.bytes === 'number' && manifest.bytes !== stat.size) {
      return sendJson(res, 409, { error: 'Geo resource size does not match its manifest' });
    }
    const etag = `"${manifest.sha256}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=0, must-revalidate' });
      res.end();
      return;
    }
    if (part === 'manifest') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        ETag: etag,
      });
      res.end(JSON.stringify(manifest));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    });
    fs.createReadStream(realData).pipe(res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return sendJson(res, 404, { error: 'Geo resource not found' });
    return sendJson(res, 500, { error: 'Failed to read geo resource' });
  }
}
