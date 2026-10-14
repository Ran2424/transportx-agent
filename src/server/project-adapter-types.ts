import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { AppPaths } from './app-paths.js';

export type ProjectAuth = {
  authenticate(headers: IncomingMessage['headers']): unknown;
  handle(req: IncomingMessage, res: ServerResponse, originAllowed: boolean): Promise<void>;
};

export type ProjectAdapter = {
  createAuth(paths: AppPaths, env: NodeJS.ProcessEnv): ProjectAuth | null;
  configureModels(registry: Pick<ExtensionAPI, 'registerProvider'>): void;
  piExtensions(appRoot: string): string[];
};
