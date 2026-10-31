type GeoReader = { entries?: unknown[]; resolvedSessionPlan?: { modules?: Array<{ id?: string }> } | null };
const published = new WeakMap<object, Map<string, string>>();
function reference(details: unknown) {
  const value = details as { kind?: string; resource?: { resourceId?: unknown; sha256?: unknown } } | undefined;
  const resource = value?.resource;
  return value?.kind === 'tau-geo-resource' && typeof resource?.resourceId === 'string' && /^geo_[a-f0-9]{16,64}$/.test(resource.resourceId) && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/.test(resource.sha256) ? { id: resource.resourceId, sha256: resource.sha256 } : null;
}
/** Only a trusted Pi tool completion can authorize a live, not-yet-flushed result. */
export function rememberPublishedGeoResource(session: object, event: { type?: unknown; toolName?: unknown; isError?: unknown; result?: unknown }) {
  if (event.type !== 'tool_execution_end' || event.toolName !== 'publish_geodata' || event.isError) return;
  const item = reference((event.result as { details?: unknown } | undefined)?.details); if (!item) return;
  const resources = published.get(session) || new Map<string, string>(); resources.set(item.id, item.sha256); published.set(session, resources);
}
export function assertGeoResourceAccess(session: GeoReader, resourceId: string, sha256: string) {
  const allowedModule = session.resolvedSessionPlan?.modules?.some((module) => module.id === 'com.transportx.geo');
  const ownHistory = session.entries?.some((row) => {
    const message = (row as { type?: string; message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown } })?.message;
    if (message?.role !== 'toolResult' || message.toolName !== 'publish_geodata' || message.isError) return false;
    const item = reference(message.details); return item?.id === resourceId && item.sha256 === sha256;
  });
  if (!allowedModule || !(published.get(session)?.get(resourceId) === sha256 || ownHistory)) throw Object.assign(new Error('This conversation has no authorized publication of this geo resource.'), { code: 'resource_forbidden', status: 403 });
}
