const { WebSocketServer, WebSocket } = require('ws');

import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocket as WsType } from 'ws';
import type { LiveSessionManager } from './sessions.js';

type TauWs = WsType & { isAlive?: boolean };

type WebSocketHandlerOptions = {
  server: Server;
  sessions: LiveSessionManager;
  isAllowedOrigin(request: import('node:http').IncomingMessage): boolean;
  authEnabled(): boolean;
  recheckAuthentication?: boolean;
  suppressChallenge?: boolean;
  isAuthenticated(request: import('node:http').IncomingMessage): boolean;
};

export function attachWebSocketHandler(options: WebSocketHandlerOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const authenticatedRequests = new Map<TauWs, import('node:http').IncomingMessage>();
  function authenticated(request: import('node:http').IncomingMessage) {
    try { return options.isAuthenticated(request); } catch { return false; }
  }

  options.server.on('upgrade', (request, socket: Socket, head) => {
    if (!options.isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (options.authEnabled() && !authenticated(request)) {
      const challenge = options.suppressChallenge ? '' : 'WWW-Authenticate: Basic realm="Tau"\r\n';
      socket.write(`HTTP/1.1 401 Unauthorized\r\n${challenge}\r\n`);
      socket.destroy();
      return;
    }
    if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws: TauWs) => wss.emit('connection', ws, request));
    else socket.destroy();
  });

  wss.on('connection', (ws: TauWs, request: import('node:http').IncomingMessage) => {
    if (options.recheckAuthentication) authenticatedRequests.set(ws, request);
    options.sessions.addClient(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'state', liveSessions: options.sessions.list(), ...options.sessions.clock() }));
    ws.on('message', () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'websocket_event_only', message: 'Use HTTP /api/rpc for commands.' }));
    });
    ws.on('close', () => { authenticatedRequests.delete(ws); options.sessions.removeClient(ws); });
    ws.on('error', () => { authenticatedRequests.delete(ws); options.sessions.removeClient(ws); });
  });

  const heartbeat = setInterval(() => {
    for (const client of options.sessions.clients as Set<TauWs>) {
      const request = authenticatedRequests.get(client);
      if (request && !authenticated(request)) { authenticatedRequests.delete(client); client.close(4001, 'Login expired'); options.sessions.removeClient(client); continue; }
      if (client.readyState !== WebSocket.OPEN) { options.sessions.removeClient(client); continue; }
      if (!client.isAlive) { try { client.terminate(); } catch {} options.sessions.removeClient(client); continue; }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, 20000);
  heartbeat.unref();

  return { wss, close: () => { clearInterval(heartbeat); authenticatedRequests.clear(); } };
}
