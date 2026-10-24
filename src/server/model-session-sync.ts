import { randomUUID } from 'node:crypto';
import { MODEL_SYNC_STATUS, RELOAD_MODELS_COMMAND } from '../contracts/model.js';
import type { RpcCommand, RpcResponse, JsonRecord } from './types.js';

type ModelSession = {
  isStreaming: boolean;
  isCompacting: boolean;
  send(command: RpcCommand, options: { timeoutMs: number }): Promise<RpcResponse>;
};

export class SessionModelSync {
  private pending: Promise<void> | undefined;
  private receipt: { token: string; error?: string } | undefined;

  consume(event: JsonRecord) {
    if (event.type !== 'extension_ui_request' || event.method !== 'setStatus' || event.statusKey !== MODEL_SYNC_STATUS) return false;
    try { this.receipt = JSON.parse(String(event.statusText)); } catch { this.receipt = undefined; }
    return true;
  }

  reload(session: ModelSession): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.perform(session).finally(() => { this.pending = undefined; this.receipt = undefined; });
    return this.pending;
  }

  private async perform(session: ModelSession) {
    const checkIdle = () => {
      if (session.isStreaming || session.isCompacting) throw new Error('模型列表已更新；当前任务正在运行，请在结束后刷新或切换模型。');
    };
    checkIdle();
    const commands = await session.send({ type: 'get_commands' }, { timeoutMs: 10_000 });
    const registered = (commands.data as { commands?: Array<{ name: string; source: string }> } | undefined)?.commands;
    // Never submit an unknown slash command: Pi would treat it as an LLM prompt.
    if (!commands.success || !registered?.some((command) => command.name === RELOAD_MODELS_COMMAND && command.source === 'extension')) {
      throw new Error('当前任务尚未加载模型同步功能，请重新打开任务。');
    }
    checkIdle();
    const token = randomUUID();
    this.receipt = undefined;
    const response = await session.send({ type: 'prompt', message: `/${RELOAD_MODELS_COMMAND} ${token}` }, { timeoutMs: 15_000 });
    if (response.success === false) throw new Error(String(response.error || '当前任务模型同步失败'));
    // Pi catches extension-command errors and still ACKs prompt. Require the
    // command's receipt, emitted before that ACK, rather than trusting it alone.
    const receipt = this.receipt as { token: string; error?: string } | undefined;
    if (receipt?.token !== token) throw new Error('当前任务未确认模型同步，请重试。');
    if (receipt.error) throw new Error(receipt.error);
  }
}
