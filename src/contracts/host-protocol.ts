export const AGENT_HOST_PROTOCOL_VERSION = 2;
export const HOST_PROTOCOL_HEADER = 'X-TransportX-Protocol';
export type HostHealth = { role: 'agent-host'; protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION; dataState: 'initializing' | 'blocked' | 'ready'; migration?: unknown };
export function compatibleHostHealth(value: unknown): value is HostHealth {
  const health = value as Partial<HostHealth> | null;
  return !!health && health.role === 'agent-host' && health.protocolVersion === AGENT_HOST_PROTOCOL_VERSION && ['initializing', 'blocked', 'ready'].includes(String(health.dataState));
}
