export const SESSION_SERVICES = ['citation', 'spatial', 'video', 'geo', 'canvas'] as const;

export type SessionService = typeof SESSION_SERVICES[number];

export const serviceModuleIds: Record<SessionService, string> = {
  citation: 'com.transportx.citation', spatial: 'com.transportx.spatial-analysis',
  video: 'com.transportx.video', geo: 'com.transportx.geo', canvas: 'com.transportx.canvas',
};

// Only these POST routes authenticate with a session service token in the router.
export const INTERNAL_SERVICE_PATHS = new Set([
  '/api/internal/citations/resolve', '/api/internal/citations/cite',
  '/api/internal/spatial/analyze', '/api/internal/geo/inspect', '/api/internal/geo/request', '/api/internal/geo/screenshot',
  '/api/internal/canvas/present', '/api/internal/canvas/inspect',
  '/api/internal/video/search', '/api/internal/video/present', '/api/internal/video/snapshot', '/api/internal/video/clip', '/api/internal/video/sample-frames',
]);

export const sessionServiceLabel: Record<SessionService, string> = {
  citation: 'Citation',
  spatial: 'Spatial Analysis',
  video: 'Video',
  geo: 'Geo',
  canvas: 'Canvas',
};
