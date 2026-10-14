import type { ProjectAdapter } from './project-adapter-types.js';

// Product builds can supply a statically selected adapter at this boundary.
export const projectAdapter: ProjectAdapter = {
  createAuth: () => null,
  configureModels: () => {},
  piExtensions: () => [],
};
