const { WebSocketServer, WebSocket } = require('ws');

import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocket as WsType } from 'ws';
import type { LiveSessionManager } from './live-session-manager.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../contracts/host-protocol.js';

type TauWs = WsType & { isAlive?: boolean; canReceive?(): boolean };

type WebSocketHandlerOptions = {
  server: Server;
  sessions: LiveSessionManager;
  isAllowedOrigin(request: IncomingMessage): boolean;
  authenticate(request: IncomingMessage): { ok: boolean; expiresAt?: number };
  pollAuthorization?: boolean;
  suppressChallenge?: boolean;
};

export function attachWebSocketHandler(options: WebSocketHandlerOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const connections = new Map<TauWs, () => void>();
  function authenticate(request: IncomingMessage): ReturnType<WebSocketHandlerOptions['authenticate']> {
    try { return options.authenticate(request); } catch { return { ok: false }; }
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    if (!options.isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const authorization = authenticate(request);
    if (!authorization.ok) {
      const challenge = options.suppressChallenge ? '' : 'WWW-Authenticate: Basic realm="Tau"\r\n';
      socket.write(`HTTP/1.1 401 Unauthorized\r\n${challenge}\r\n`);
      socket.destroy();
      return;
    }
    if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws: TauWs) => wss.emit('connection', ws, request, authorization));
    else socket.destroy();
  }
  options.server.on('upgrade', upgrade);

  wss.on('connection', (ws: TauWs, request: IncomingMessage, authorization: ReturnType<typeof authenticate>) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let negotiated = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => { if (!negotiated) ws.close(4006, 'unsupported_client'); }, 5000); timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(expiry);
      connections.delete(ws);
      options.sessions.removeClient(ws);
    };
    const scheduleExpiry = (expiresAt?: number) => {
      if (expiry !== undefined || expiresAt === undefined) return;
      expiry = setTimeout(() => {
        expiry = undefined;
        canReceive();
      }, Math.max(0, expiresAt * 1000 - Date.now())).unref();
    };
    const canReceive = () => {
      if (!connections.has(ws) || ws.readyState !== WebSocket.OPEN) return false;
      const current = authenticate(request);
      if (current.ok) {
        scheduleExpiry(current.expiresAt);
        return true;
      }
      cleanup();
      ws.close(4001, 'Login expired');
      return false;
    };
    ws.canReceive = canReceive;
    connections.set(ws, cleanup);
    scheduleExpiry(authorization.expiresAt);
    ws.on('message', (raw: Buffer) => {
      if (!canReceive()) return;
      if (!negotiated) {
        let hello: { type?: string; protocolVersion?: number } = {};
        try { const value = JSON.parse(raw.toString()); if (value && typeof value === 'object' && !Array.isArray(value)) hello = value; } catch {}
        if (hello.type !== 'hello' || hello.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) { ws.send(JSON.stringify({ type: 'error', code: 'unsupported_client', message: 'Upgrade or restart the client.' })); ws.close(4006, 'unsupported_client'); return; }
        const state = JSON.stringify({ type: 'state', protocolVersion: AGENT_HOST_PROTOCOL_VERSION, liveSessions: options.sessions.list(), ...options.sessions.clock() });
        if (!canReceive()) return;
        negotiated = true;
        clearTimeout(timeout);
        options.sessions.addClient(ws);
        ws.send(state);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'websocket_event_only', message: 'Use HTTP /api/rpc for commands.' }));
    });
    ws.on('close', cleanup);
    ws.on('error', () => { cleanup(); ws.terminate(); });
  });

  const revalidate = () => { for (const client of connections.keys()) client.canReceive?.(); };
  // Project adapters currently expose a pull-only decision for idle sockets.
  const authorizationPoll = options.pollAuthorization ? setInterval(revalidate, 20000).unref() : undefined;
  const heartbeat = setInterval(() => {
    for (const [client, cleanup] of connections) {
      if (client.readyState !== WebSocket.OPEN) { cleanup(); continue; }
      if (!client.isAlive) { cleanup(); client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch { cleanup(); client.terminate(); }
    }
  }, 20000);
  heartbeat.unref();

  return { wss, revalidate, close: () => {
    options.server.off('upgrade', upgrade);
    clearInterval(heartbeat);
    clearInterval(authorizationPoll);
    for (const cleanup of connections.values()) cleanup();
    for (const client of wss.clients as Set<TauWs>) client.terminate();
  } };
}
