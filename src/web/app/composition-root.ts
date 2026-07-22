import { createAppKernel } from '../../public/kernel/app-kernel.js';
import { WebSocketClient } from '../../public/websocket-client.js';

const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const transport = new WebSocketClient(wsUrl);

export const appKernel = createAppKernel({
  transport,
  http: (path, init) => fetch(path, {
    method: init?.method,
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  }),
});

let started = false;

export function startBrowserApplication() {
  if (started) return;
  started = true;
  appKernel.dispatch({ type: 'runtime/connecting' });
  transport.connect();
}

export function reconnectBrowserApplication() {
  appKernel.dispatch({ type: 'runtime/connecting' });
  transport.forceReconnect();
}
