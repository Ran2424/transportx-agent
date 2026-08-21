export const SESSION_SERVICES = ['citation', 'spatial', 'video'] as const;

export type SessionService = typeof SESSION_SERVICES[number];

export const sessionServiceLabel: Record<SessionService, string> = {
  citation: 'Citation',
  spatial: 'Spatial Analysis',
  video: 'Video',
};
