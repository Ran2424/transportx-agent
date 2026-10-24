import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { readJsonObject } from './util/json-storage.js';
import { projectAdapter } from './project-adapter.js';

// Pi owns the catalog, credentials and cache. Serialize access to its mutable
// runtime so a config reload cannot race a network refresh or credential edit.
export function createPiModelRuntime(agentDir: string, options: Pick<CreateModelRuntimeOptions, 'catalogBaseUrl'> = {}) {
  let runtime: ModelRuntime | undefined;
  let signature = '';
  let pending: Promise<unknown> = Promise.resolve();
  return function useRuntime<T>(action: (runtime: ModelRuntime) => Promise<T>): Promise<T> {
    const operation = pending.then(async () => {
      const config = ['auth.json', 'models.json'].map((file) => readJsonObject(path.join(agentDir, file)));
      const next = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      if (!runtime) {
        const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
        runtime = await ModelRuntime.create({ ...options, authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false });
        projectAdapter.configureModels(runtime);
      } else if (signature !== next) await runtime.reloadConfig();
      const error = runtime.getError();
      if (error) throw new Error(error);
      signature = next;
      return action(runtime);
    });
    pending = operation.catch(() => {});
    return operation;
  };
}

let scope: { agentDir: string; use: ReturnType<typeof createPiModelRuntime> } | undefined;
export function piModelRuntime(agentDir: string) {
  if (!scope || scope.agentDir !== agentDir) scope = { agentDir, use: createPiModelRuntime(agentDir) };
  return scope.use;
}
