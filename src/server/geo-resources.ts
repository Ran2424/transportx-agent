
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readVerifiedGeoResource } from './geo-resource-storage.js';
import { writeJson as sendJson } from './http/response.js';

type GeoResourceSession = { cwd: string };
type GeoResourceRouteDeps = { getSession(sessionId: string): GeoResourceSession | null | undefined };

const RESOURCE_ID_RE = /^geo_[a-f0-9]{16,64}$/;
const GEO_RESOURCE_ROUTE_RE = /^\/api\/live-sessions\/([^/]+)\/geo-resources\/([^/]+)\/(manifest|data)$/;

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
  try {
    const { manifest, buffer: data } = readVerifiedGeoResource(session.cwd, resourceId);
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
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    });
    res.end(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return sendJson(res, 404, { error: 'Geo resource not found' });
    const status = (error as { status?: number }).status;
    return sendJson(res, status || 500, { error: status ? (error as Error).message : 'Failed to read geo resource' });
  }
}
