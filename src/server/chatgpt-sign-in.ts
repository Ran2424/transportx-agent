import { randomUUID } from 'node:crypto';
import { CHATGPT_PLAN_PROVIDER, type ChatGPTSignIn } from '../contracts/chatgpt-plan.js';
import { createPiModelRuntime } from './pi-model-runtime.js';
import { registerChatGPTPlanProvider } from './chatgpt-provider.js';
import { assertHostWriter } from './util/json-storage.js';

type Attempt = {
  agentDir: string;
  view: ChatGPTSignIn;
  ready: Promise<ChatGPTSignIn>;
  abort: AbortController;
};
let active: Attempt | undefined;

export function chatGPTSignIn(agentDir: string, action: unknown, id?: unknown, newAccount = false) {
  assertHostWriter(agentDir);
  if (action === 'status' || action === 'cancel') {
    if (!active || active.agentDir !== agentDir || active.view.id !== id) throw new Error('ChatGPT 授权已结束，请重新开始。');
    if (action === 'cancel' && active.view.status === 'waiting') active.abort.abort();
    return active.view;
  }
  if (action !== 'start') throw new Error('未知的 ChatGPT 授权操作。');
  if (active?.agentDir === agentDir && active.view.status === 'waiting' && !active.abort.signal.aborted) return active.ready;
  active?.abort.abort();
  let ready!: (result: ChatGPTSignIn) => void;
  const attempt: Attempt = {
    agentDir, view: { id: randomUUID(), status: 'waiting' },
    ready: new Promise((resolve) => { ready = resolve; }), abort: new AbortController(),
  };
  active = attempt;
  // The normal catalog queue remains available while the browser is open.
  void createPiModelRuntime(agentDir)(async (runtime) => {
    if (newAccount) await registerChatGPTPlanProvider(runtime, agentDir, undefined, true);
    await runtime.login(CHATGPT_PLAN_PROVIDER, 'oauth', {
      signal: attempt.abort.signal,
      async prompt() { throw new Error('请在浏览器完成 ChatGPT 授权。'); },
      notify(event) {
        if (event.type !== 'auth_url') return;
        attempt.view = { ...attempt.view, authorizationUrl: event.url };
        ready(attempt.view);
      },
    });
    attempt.view = { id: attempt.view.id, status: 'connected' };
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const safeMessage = message.startsWith('ChatGPT ') || message.startsWith('未授予') ? message : 'ChatGPT 连接失败，请重试。';
    attempt.view = { id: attempt.view.id, status: 'failed', error: safeMessage };
  }).finally(() => ready(attempt.view));
  return attempt.ready;
}
