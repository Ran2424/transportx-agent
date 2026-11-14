import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiRouteServices } from './api-services.js';
import type { LiveSessionManager } from './live-session-manager.js';
import type { PiRpcSession } from './sessions.js';
import type { RpcCommand } from './types.js';
import { serviceModuleIds, sessionServiceLabel, type SessionService } from './session-service.js';

export async function withRequestSignal<T>(req: IncomingMessage, res: ServerResponse, execute: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.once('aborted', cancel);
  res.once('close', cancel);
  try { return await execute(controller.signal); }
  finally { req.off('aborted', cancel); res.off('close', cancel); }
}

export function runRequestJob<T>(sessions: LiveSessionManager, req: IncomingMessage, res: ServerResponse, session: PiRpcSession, execute: (signal: AbortSignal) => Promise<T>) {
  return withRequestSignal(req, res, (signal) => sessions.runJob(session.id, execute, signal));
}

export function resolveServiceSession(res: ServerResponse, body: RpcCommand, services: ApiRouteServices, service: SessionService) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const session = services.sessions.get(sessionId);
  if (!session || session.terminating || !session.resolvedSessionPlan?.modules?.some((module) => module.id === serviceModuleIds[service]) || !token || token !== session.serviceTokens[service]) { services.json(res, 403, { error: `${sessionServiceLabel[service]} host access denied` }); return null; }
  try { if (!session.lifecycle?.isCurrent(session) || services.workspaces.target(session.conversationId).manifest.id !== session.workspaceId) throw new Error('Runtime binding changed.'); }
  catch { services.json(res, 403, { error: `${sessionServiceLabel[service]} runtime binding denied` }); return null; }
  return session;
}

export function resolveLiveSessionParam(res: ServerResponse, value: string, services: ApiRouteServices) {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { services.json(res, 400, { error: 'Malformed live session id' }); return null; }
  try { return services.workspaces.live(id); }
  catch (error) { services.json(res, services.errorStatus(error), { error: services.errorMessage(error), code: (error as { code?: string }).code }); return null; }
}

export function resolveResourceContextParam(res: ServerResponse, value: string, services: ApiRouteServices) {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { services.json(res, 400, { error: 'Malformed conversation id' }); return null; }
  try { return services.workspaces.resourceContext(id); }
  catch (error) { services.json(res, services.errorStatus(error), { error: services.errorMessage(error), code: (error as { code?: string }).code }); return null; }
}

export function resolveConversationTargetParam(res: ServerResponse, value: string, services: ApiRouteServices) {
  try { return services.workspaces.target(decodeURIComponent(value)); }
  catch (error) { services.json(res, services.errorStatus(error), { error: services.errorMessage(error), code: (error as { code?: string }).code }); return null; }
}
