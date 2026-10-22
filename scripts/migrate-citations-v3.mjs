// Explicit, backed-up V2 registry migration. Run after npm run build:server.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const { planCitationMigration, applyCitationMigrations } = require('../bin/citation-migration.js');
const { citationMigrationWorkspaces } = require('../bin/citation-migration.js');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rootArgument, mode] = process.argv.slice(2);
  if (!rootArgument || (mode && mode !== '--apply') || process.argv.length > 4) throw new Error('Usage: node scripts/migrate-citations-v3.mjs <data-root> [--apply] (default: dry run)');
  const dataRoot = fs.realpathSync(rootArgument), scenario = path.join(dataRoot, 'scenario');
  const plans = citationMigrationWorkspaces(dataRoot, scenario, path.join(dataRoot, 'sessions')).flatMap((cwd) => {
    const plan = planCitationMigration(cwd);
    return plan ? [plan] : [];
  });
  const files = plans.flatMap((plan) => plan.files);
  const backup = mode === '--apply' ? applyCitationMigrations(dataRoot, plans) : null;
  console.log(JSON.stringify({ mode: mode === '--apply' ? 'applied' : 'dry-run', registries: plans.length, sources: plans.reduce((sum, plan) => sum + plan.registry.sources.length, 0), evidence: plans.reduce((sum, plan) => sum + plan.registry.evidence.length, 0), originals: Object.fromEntries(['verified', 'content-changed', 'missing'].map((status) => [status, files.filter((file) => file.status === status).length])), backup }, null, 2));
}
