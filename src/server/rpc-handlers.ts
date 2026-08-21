import type { RpcCommand, RpcResponse } from './types.js';

export type RpcReply = {
  success(data?: unknown): RpcResponse;
  failure(message: string): RpcResponse;
};

export type RpcHandler = (command: RpcCommand, reply: RpcReply) => RpcResponse | Promise<RpcResponse>;
export type RpcHandlerRegistry = Record<string, { handle: RpcHandler; native?: boolean }>;
