import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  ResilienceAlignSchema, ResilienceImportSchema, ResilienceInvestigateSchema, ResiliencePressureSchema,
  ResilienceAccessibilitySchema, ResilienceComparePlansSchema, ResilienceEventAlignmentSchema, ResilienceJointSensitivitySchema,
} from '../../../../../src/contracts/tool-definitions.mts';
import { alignObservations, importOsmNetwork, importSurveyObservations } from './adapters.ts';
import { parseNetwork, parseObservations } from './model.ts';
import { digest, jsonBytes, publish, readInput } from './workspace-files.ts';
import { loadCase, method, runWorkspaceCase } from './workspace-run.ts';
import { scanSensitivity } from './sensitivity.ts';
import { comparePlans, publishAccessibility, publishEventAlignment, publishJointSensitivity } from './decision-tools.ts';
import { runDecisionWorkflow } from './decision-workflow.ts';

const textResult = (content: string, details: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: content }], details: { kind: 'service-resilience-result', ...details },
});

export default function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'resilience_import', label: '导入韧性分析输入',
    description: 'Import a workspace Overpass road response or QField/ODK CSV into a content-identified file. For OSM supply an assumed speed and mode=road. For CSV supply five explicit column names. Inputs stay local.',
    parameters: ResilienceImportSchema,
    execute: async (_id, args, signal, _update, ctx) => {
      signal?.throwIfAborted();
      const input = readInput(ctx.cwd, args.sourcePath);
      const source = { path: args.sourcePath, sha256: input.sha256 };
      const stem = 'resilience-' + digest(JSON.stringify({ method, ...args, sha256: input.sha256 })).slice(0, 20);
      if (args.kind === 'osm-overpass') {
        if (args.speedKph === undefined || args.mode !== 'road' || args.columns) throw new Error('OSM needs explicit speedKph and mode=road.');
        const { nodes, edges, notes } = importOsmNetwork(JSON.parse(input.text), { speedKph: args.speedKph, mode: args.mode });
        parseNetwork({ nodes, edges });
        const attribution = '© OpenStreetMap contributors · https://www.openstreetmap.org/copyright · ODbL';
        const file = publish(ctx.cwd, stem + '-network.json', jsonBytes({ protocol: 'transportx-resilience-network', version: 1,
          source, attribution, notes: [...notes, attribution], nodes, edges }));
        const summary = { ...file, source, attribution, nodes: nodes.length, edges: edges.length, notes };
        return textResult(JSON.stringify(summary), { operation: 'import-network', ...summary });
      }
      if (!args.columns || args.speedKph !== undefined || args.mode) throw new Error('Field surveys need an explicit CSV column mapping.');
      const observations = parseObservations(importSurveyObservations(input.text, args.columns));
      const file = publish(ctx.cwd, stem + '-observations.json', jsonBytes({ protocol: 'transportx-resilience-observations', version: 1, source, observations }));
      const summary = { ...file, source, observations: observations.length };
      return textResult(JSON.stringify(summary), { operation: 'import-observations', ...summary });
    },
  });
  pi.registerTool({
    name: 'resilience_align', label: '对齐调查记录和时空对象',
    description: 'Check observation IDs against a resilience case and report exact matches, unknown objects and unknown periods. Does not update a case or approve the observations.',
    parameters: ResilienceAlignSchema,
    execute: async (_id, args, signal, _update, ctx) => {
      signal?.throwIfAborted();
      const { model, inputs } = loadCase(ctx.cwd, args.casePath);
      const input = readInput(ctx.cwd, args.observationPath);
      const data = JSON.parse(input.text);
      const observations = parseObservations(Array.isArray(data) ? data : data?.observations);
      const objects = [...model.nodes, ...model.edges, ...model.services, ...model.demands];
      const resources = [...model.edges, ...model.services].flatMap(item => item.requires);
      const report = alignObservations(observations, [...new Set([...objects.map(item => item.id), ...resources])], model.periods.map(item => item.id));
      const sources = [...inputs, { role: 'observations', path: args.observationPath, sha256: input.sha256 }];
      const body = jsonBytes({ protocol: 'transportx-resilience-alignment', version: 1, method, sources, ...report });
      const file = publish(ctx.cwd, 'resilience-' + digest(body).slice(0, 20) + '-alignment.json', body);
      const summary = { ...file, coverage: report.coverage };
      return textResult(JSON.stringify(summary), { operation: 'align', ...summary });
    },
  });

  pi.registerTool({
    name: 'resilience_align_events', label: '对齐事件、设施与生效时段',
    description: 'Align local WGS84 GeoJSON events to case objects and a timezone-aware calendar. Return source coverage, ambiguous spatial candidates and exact confirmations. Review event IDs before using confirmations in a plan.',
    parameters: ResilienceEventAlignmentSchema,
    execute: async (_id, args, signal, _update, ctx) => {
      signal?.throwIfAborted();
      const result = publishEventAlignment(ctx.cwd, args);
      return textResult(JSON.stringify(result), { operation: 'align-events', ...result });
    },
  });
  pi.registerTool({
    name: 'resilience_accessibility', label: '核算网络可达性与绕行',
    description: 'For one time slice, compare baseline and selected directed routes by cohort travel mode, reachable options and time threshold; publish nearest route paths and GeoJSON. Run plan comparison to allocate shared capacity.',
    parameters: ResilienceAccessibilitySchema,
    execute: async (_id, args, signal, _update, ctx) => {
      const result = publishAccessibility(ctx.cwd, args, signal);
      return textResult(JSON.stringify(result), { operation: 'accessibility', ...result });
    },
  });
  pi.registerTool({
    name: 'resilience_compare_plans', label: '冻结并批量比较应对方案',
    description: 'Freeze baseline and plan definitions from local JSON. Optionally bind explicitly reviewed event IDs to one state using a verified alignment artifact. Publish the replayable RFC 6902 edit and batch comparison report, table, and map.',
    parameters: ResilienceComparePlansSchema,
    execute: async (_id, args, signal, _update, ctx) => {
      const { reportBody: _report, ...result } = comparePlans(ctx.cwd, args, signal);
      return textResult(JSON.stringify(result), { operation: 'compare-plans', ...result });
    },
  });
  pi.registerTool({
    name: 'resilience_sensitivity', label: '多因素敏感性与方案筛选',
    description: 'Scan one to three explicit axes in a chosen state and period, reporting plan changes, joint failures, feasible and Pareto plans and candidate investigation questions. Limits are weighted unmet service demand; grid is bounded.',
    parameters: ResilienceJointSensitivitySchema,
    execute: async (_id, args, signal, _update, ctx) => {
      signal?.throwIfAborted();
      const result = publishJointSensitivity(ctx.cwd, args);
      return textResult(JSON.stringify(result), { operation: 'joint-sensitivity', ...result });
    },
  });

  pi.registerTool({
    name: 'resilience_pressure_test', label: '运行城市服务中断压力测试',
    description: 'Compare all stated disruption and response combinations. Optional state, plan and period IDs choose the map slice. Returns verifiable report, CSV, GeoJSON and full results. Omit casePath for the synthetic exercise.',
    parameters: ResiliencePressureSchema,
    execute: async (_id, { casePath, ...view }, signal, _update, ctx) => {
      const { reportBody: _report, ...summary } = runWorkspaceCase(ctx.cwd, casePath, view, signal);
      return textResult(JSON.stringify(summary), { operation: 'pressure-test', ...summary });
    },
  });
  pi.registerTool({
    name: 'resilience_investigate', label: '评估下一项调查',
    description: 'Rank the case investigations by reduction of worst-case decision regret. Optionally scan one edge travel time or service capacity at explicitly specified values to find brackets where the preferred plans change. No state probabilities are inferred.',
    parameters: ResilienceInvestigateSchema,
    execute: async (_id, { casePath, sweep }, signal, _update, ctx) => {
      if (sweep) {
        signal?.throwIfAborted();
        const { model, inputs, notes } = loadCase(ctx.cwd, casePath);
        const scanned = scanSensitivity(model, sweep);
        const result = { protocol: 'transportx-resilience-sensitivity', version: 1, method, inputs, notes, provenance: model.provenance, ...scanned };
        const body = jsonBytes(result);
        const file = publish(ctx.cwd, 'resilience-' + digest(body).slice(0, 20) + '-sensitivity.json', body);
        const summary = { ...file, brackets: scanned.brackets, assumptions: scanned.assumptions };
        return textResult(JSON.stringify(summary), { operation: 'scan-sensitivity', ...summary });
      }
      const { runId, decision, investigations, files, provenance } = runWorkspaceCase(ctx.cwd, casePath, {}, signal);
      const summary = { runId, decision, investigations, files, provenance };
      return textResult(JSON.stringify(summary), { operation: 'investigate', ...summary });
    },
  });

  const publishCommand = (cwd: string, casePath?: string) => {
    try {
      const { reportBody, ...details } = runWorkspaceCase(cwd, casePath);
      pi.sendMessage({ customType: 'service-resilience-result', display: true, details,
        content: reportBody + '\n工作区文件 · `' + details.files.report.path + '` · `' + details.files.comparison.path + '` · `' + details.files.map.path + '`' },
      { triggerTurn: false });
    } catch (error) {
      const message = error instanceof Error ? error.message.split(/\r?\n/u)[0].slice(0, 500) : '计算失败';
      pi.sendMessage({ customType: 'service-resilience-error', display: true, content: '城市服务韧性 · ' + message }, { triggerTurn: false });
    }
  };
  pi.registerCommand('resilience-demo', {
    description: 'Run both analyses on the built-in synthetic exercise without a model call.',
    handler: async (_, ctx) => publishCommand(ctx.cwd),
  });
  pi.registerCommand('resilience-workflow', {
    description: 'Run event alignment, reviewed plan comparison, network accessibility and joint sensitivity. Supply a local workflow JSON, or omit it for the exercise.',
    handler: async (args, ctx) => {
      try {
        const { reportBody, ...details } = runDecisionWorkflow(ctx.cwd, args.trim() || undefined);
        pi.sendMessage({ customType: 'service-resilience-result', display: true, details,
          content: reportBody + '\n工作区文件 · `' + details.files.report.path + '` · `' + details.files.manifest.path + '`' },
        { triggerTurn: false });
      } catch (error) {
        const message = error instanceof Error ? error.message.split(/\r?\n/u)[0].slice(0, 500) : '计算失败';
        pi.sendMessage({ customType: 'service-resilience-error', display: true, content: '城市服务韧性 · ' + message }, { triggerTurn: false });
      }
    },
  });
  pi.registerCommand('resilience-run', {
    description: 'Run both analyses on a JSON case from the current workspace.',
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) {
        pi.sendMessage({ customType: 'service-resilience-error', display: true, content: '用法 · /resilience-run <工作区相对案例路径>' },
          { triggerTurn: false });
        return;
      }
      publishCommand(ctx.cwd, path);
    },
  });
}
