import { readFileSync } from 'node:fs';
import { runPressureTest } from './engine.ts';
import { rankInvestigations } from './investigation.ts';
import { parseCase, parseNetwork, type ResilienceCase } from './model.ts';
import { comparisonCsv, pressureMap, renderReport, type ViewSelection } from './presentation.ts';
import { digest, jsonBytes, publish, readInput } from './workspace-files.ts';

export const method = 'service-resilience-v2';
const asset = new URL('../../examples/east-bridge.exercise.json', import.meta.url);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function loadCase(cwd: string, casePath?: string, expectedCaseSha256?: string) {
  const src = casePath ? readInput(cwd, casePath) : (() => {
    const bytes = readFileSync(asset);
    return { text: bytes.toString('utf8'), sha256: digest(bytes) };
  })();
  if (expectedCaseSha256 && src.sha256 !== expectedCaseSha256) throw new Error('Case input hash mismatch.');
  const raw = object(JSON.parse(src.text));
  if (!raw) throw new Error('A resilience case must be a JSON object.');
  const inputs = [{ role: 'case', path: casePath ?? 'examples/east-bridge.exercise.json', sha256: src.sha256 }];
  if (Object.hasOwn(raw, 'networkPath')) {
    const { networkPath, ...rest } = raw;
    if (typeof networkPath !== 'string' || 'nodes' in rest || 'edges' in rest || 'networkEvidence' in rest) throw new Error('Use networkPath or inline nodes and edges.');
    const file = readInput(cwd, networkPath);
    const parsed = object(JSON.parse(file.text));
    if (!parsed) throw new Error('Expected a local resilience network.');
    const network = parseNetwork({ nodes: parsed.nodes, edges: parsed.edges });
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((note): note is string => typeof note === 'string').map(note => note.slice(0, 500)).slice(0, 10) : [];
    const attribution = typeof parsed.attribution === 'string' ? parsed.attribution.slice(0, 500) : undefined;
    if (attribution && !notes.includes(attribution)) notes.push(attribution);
    inputs.push({ role: 'network', path: networkPath, sha256: file.sha256 });
    return { model: parseCase({ ...rest, ...network, networkEvidence: { path: networkPath, sha256: file.sha256, notes } }), inputs, notes };
  }
  const model = parseCase(raw);
  return { model, inputs, notes: model.networkEvidence?.notes ?? [] };
}

function chooseView(model: ResilienceCase, values: Partial<ViewSelection>, defaultPlan: string): ViewSelection {
  const stateId = values.stateId ?? (model.states.find(state => Object.keys(state.periods).length) ?? model.states[0]).id;
  const planId = values.planId ?? defaultPlan;
  const periodId = values.periodId ?? model.periods[0].id;
  if (!model.states.some(state => state.id === stateId) || !model.plans.some(plan => plan.id === planId) ||
      !model.periods.some(period => period.id === periodId)) throw new Error('Unknown map selection: use a case state, plan and period ID.');
  return { stateId, planId, periodId };
}

export function runWorkspaceCase(cwd: string, casePath?: string, viewOptions: Partial<ViewSelection> = {}, signal?: AbortSignal,
  expectedCaseSha256?: string) {
  signal?.throwIfAborted();
  const { model, inputs, notes } = loadCase(cwd, casePath, expectedCaseSha256);
  const pressure = runPressureTest(model);
  const ranking = rankInvestigations(model, pressure);
  const view = chooseView(model, viewOptions, ranking.beforeObservation.recommendedPlanId ?? model.plans[0].id);
  const caseHash = inputs[0].sha256;
  const runId = digest(JSON.stringify({ method, inputs, view }));
  const stem = 'resilience-' + runId.slice(0, 20);
  const binding = { protocol: 'transportx-service-resilience', version: 1, method, runId, provenance: model.provenance, inputs, notes, view };
  const reportBody = renderReport(model, pressure, ranking, view, runId, caseHash) + (notes.length
    ? '\n## 路网导入与适用范围\n\n' + notes.map(note => '- ' + note.replace(/[\r\n<>]/gu, ' ')).join('\n') + '\n'
    : '');
  signal?.throwIfAborted();
  const scenarioFile = publish(cwd, stem + '-case.json', jsonBytes(model));
  const pressureFile = publish(cwd, stem + '-pressure.json', jsonBytes({ ...binding, ...pressure }));
  const investigationFile = publish(cwd, stem + '-investigation.json', jsonBytes({ ...binding, ...ranking }));
  const csvFile = publish(cwd, stem + '-comparison.csv', comparisonCsv(pressure));
  const mapFile = publish(cwd, stem + '-map.geojson', jsonBytes({ ...pressureMap(model, pressure, view), ...(notes.length ? { notes } : {}) }));
  const files = { case: scenarioFile, pressure: pressureFile, investigation: investigationFile, comparison: csvFile, map: mapFile };
  const manifest = publish(cwd, stem + '-manifest.json', jsonBytes({ ...binding, files, reportSha256: digest(reportBody) }));
  // Publish the report last so its presence marks a complete run.
  const report = publish(cwd, stem + '-report.md', reportBody);
  return {
    ...binding,
    reportBody,
    files: { ...files, manifest, report },
    scenarioTotals: pressure.scenarios.map(({ stateId, planId, shortage, priorityShortage, restored }) =>
      ({ stateId, planId, shortage, priorityShortage, restored })),
    decision: ranking.beforeObservation,
    investigations: ranking.investigations.map(({ investigationId, timely, leadMinutes, improvement, decision }) =>
      ({ investigationId, timely, leadMinutes, improvement, decision })),
  };
}
