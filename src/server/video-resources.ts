const fs = require('node:fs');
const path = require('node:path');

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseVideoResourceManifestStructured } from '../contracts/index.js';
import { isWithin } from './util/path.js';
import { writeJson as sendJson } from './http/response.js';

type VideoResourceSession = { cwd: string };
type VideoResourceRouteDeps = { getSession(sessionId: string): VideoResourceSession | null | undefined };

const RESOURCE_ID_RE = /^video_[a-f0-9]{16}$/;
const VIDEO_RESOURCE_ROUTE_RE = /^\/api\/live-sessions\/([^/]+)\/video-resources\/([^/]+)\/data$/;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

export function handleVideoResourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  cleanPath: string,
  deps: VideoResourceRouteDeps,
) {
  const match = cleanPath.match(VIDEO_RESOURCE_ROUTE_RE);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Only GET and HEAD are supported for video resources' });
    return true;
  }
  let sessionId: string;
  let resourceId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    resourceId = decodeURIComponent(match[2]);
  } catch {
    sendJson(res, 400, { error: 'Malformed video resource URL' });
    return true;
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Live session not found' });
    return true;
  }
  serveVideoResource(req, res, session, resourceId);
  return true;
}

function serveVideoResource(req: IncomingMessage, res: ServerResponse, session: VideoResourceSession, resourceId: string) {
  if (!RESOURCE_ID_RE.test(resourceId)) return sendJson(res, 400, { error: 'Invalid video resource id' });
  const root = path.resolve(session.cwd, '.tau', 'video-resources');
  const resourceDir = path.resolve(root, resourceId);
  if (!isWithin(root, resourceDir)) return sendJson(res, 403, { error: 'Video resource is outside the active task' });
  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(resourceDir);
    const realManifest = fs.realpathSync(path.join(realDir, 'manifest.json'));
    const realVideo = fs.realpathSync(path.join(realDir, 'video.mp4'));
    if (!isWithin(realRoot, realDir) || !isWithin(realDir, realManifest) || !isWithin(realDir, realVideo)) {
      return sendJson(res, 403, { error: 'Video resource path is not allowed' });
    }
    const parsed = parseVideoResourceManifestStructured(JSON.parse(fs.readFileSync(realManifest, 'utf8')));
    if (!parsed.ok || parsed.value.resourceId !== resourceId) return sendJson(res, 409, { error: 'Video resource manifest is invalid' });
    const stat = fs.statSync(realVideo);
    if (parsed.value.bytes !== stat.size) return sendJson(res, 409, { error: 'Video resource size does not match its manifest' });

    const baseHeaders = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } as const;

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
    if (rangeHeader) {
      const match = rangeHeader.match(RANGE_RE);
      const start = match && match[1] !== '' ? Number(match[1]) : null;
      const end = match && match[2] !== '' ? Number(match[2]) : null;
      // V1 supports a single byte range only; multipart ranges are rejected.
      if (!match || (start === null && end === null) || (start !== null && end !== null && start > end)) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      let rangeStart: number;
      let rangeEnd: number;
      if (start === null) {
        rangeStart = Math.max(0, stat.size - (end as number));
        rangeEnd = stat.size - 1;
      } else {
        rangeStart = start;
        rangeEnd = end === null ? stat.size - 1 : Math.min(end, stat.size - 1);
      }
      if (rangeStart >= stat.size || rangeStart > rangeEnd) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${stat.size}`,
        'Content-Length': rangeEnd - rangeStart + 1,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(realVideo, { start: rangeStart, end: rangeEnd }).pipe(res);
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(realVideo).pipe(res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return sendJson(res, 404, { error: 'Video resource not found' });
    return sendJson(res, 500, { error: 'Failed to read video resource' });
  }
}
