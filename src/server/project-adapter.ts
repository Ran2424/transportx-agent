import path from 'node:path';
import { registerChatGPTPlanProvider } from './chatgpt-provider.js';
import type { ProjectAdapter } from './project-adapter-types.js';

// Product builds can supply a statically selected adapter at this boundary.
export const projectAdapter: ProjectAdapter = {
  createAuth: () => null,
  configureModels: registerChatGPTPlanProvider,
  piExtensions: (appRoot) => [path.join(appRoot, 'bin', 'chatgpt-pi-extension.js')],
};
