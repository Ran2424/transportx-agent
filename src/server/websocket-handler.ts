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
  isAuthenticated(request: import('node:http').IncomingMessage): boolean;
};

export function attachWebSocketHandler(options: WebSocketHandlerOptions) {
  const wss = new WebSocketServer({ noServer: true });

  options.server.on('upgrade', (request, socket: Socket, head) => {
    if (!options.isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (options.authEnabled() && !options.isAuthenticated(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Tau"\r\n\r\n');
      socket.destroy();
      return;
    }
    if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws: TauWs) => wss.emit('connection', ws, request));
    else socket.destroy();
  });

  wss.on('connection', (ws: TauWs) => {
    options.sessions.addClient(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'state', liveSessions: options.sessions.list() }));
    ws.on('message', () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', code: 'websocket_event_only', message: 'Use HTTP /api/rpc for commands.' }));
    });
    ws.on('close', () => options.sessions.removeClient(ws));
    ws.on('error', () => options.sessions.removeClient(ws));
  });

  const heartbeat = setInterval(() => {
    for (const client of options.sessions.clients as Set<TauWs>) {
      if (client.readyState !== WebSocket.OPEN) { options.sessions.removeClient(client); continue; }
      if (!client.isAlive) { try { client.terminate(); } catch {} options.sessions.removeClient(client); continue; }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, 20000);
  heartbeat.unref();

  return { wss, close: () => clearInterval(heartbeat) };
}
