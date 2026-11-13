import { readFileSync } from 'node:fs';
import type { TSchema } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { parseTrafficToolResult } from '../../../../../src/contracts/simulation.ts';
import { parseCanvasPresentation } from '../../../../../src/contracts/canvas.ts';
import { postHostOperation } from '../../../../shared/host-client.ts';

const definitions = [
  { file: 'prepare-contract.json', route: 'prepare', label: '准备交通场景', description: 'Validate and freeze a TrafficScenario file from this workspace or an explicitly selected Data asset. Returns missing/unsupported input errors; never invents source data or starts a simulation.' },
  { file: 'run-contract.json', route: 'run', label: '运行交通仿真', description: 'Execute one bounded SUMO/TraCI Run for a prepared scenario. Publishes a Simulation Canvas while running. Preserve the original Run on cancellation or unknown results; query it instead of automatically repeating.' },
  { file: 'execution-contract.json', route: 'execution', label: '查询交通仿真执行', description: 'Query or request cancellation of an existing Run using runId or the original lookupToolCallId. A cancellation request does not confirm stopping. Never starts or repeats a Run.' },
  { file: 'query-contract.json', route: 'query', label: '查询仿真结果', description: 'Read a Run at an explicit already-computed time and optional vehicle, traveler, node or route ID. position is SUMO network XY metres; only lanePositionMeters is lane distance. positionGeo is WGS84 longitude/latitude degrees, speed is m/s. Events are bounded and associated with the selected object; incomplete results cannot prove benefits.' },
  { file: 'experiment-contract.json', route: 'experiment', label: '交通实验清单与比较', description: 'Prepare a bounded sequential paired-seed experiment from a frozen baseline and its declared variant, or query the original experiment. Does not dispatch Runs. Execute each next slot once through traffic_run with experimentId/slot. Preserves failed, cancelled and unknown samples and returns an immutable comparison manifest and Markdown report; never automatically replaces a Run.' },
].map((definition) => {
  const contract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL(`../../${definition.file}`, import.meta.url), 'utf8')));
  if (!contract) throw new Error('Invalid Traffic Tool Contract');
  return { ...definition, contract };
});
const host = () => ({ endpoint: process.env.TAU_TRAFFIC_ENDPOINT, sessionId: process.env.TAU_TRAFFIC_SESSION_ID, token: process.env.TAU_TRAFFIC_TOKEN });
type Result = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };
const failure = (code: string, message: string, toolCallId: string, runId?: string): Result => ({ content: [{ type: 'text', text: JSON.stringify({ code, message, runId, toolCallId, recovery: 'Use traffic_execution with the original runId or lookupToolCallId. A missing response is not proof of non-execution. Do not automatically create a replacement Run.' }) }], details: { kind: 'traffic-error', error: { code, message, toolCallId, runId } } });

export default function trafficSimulationExtension(pi: ExtensionAPI) {
  const pending = new Map<string, { dispatched: boolean; runId?: string; result?: Result }>();
  pi.on('session_shutdown', () => pending.clear());
  pi.on('tool_result', (event) => {
    if (!definitions.some((definition) => definition.contract.piName === event.toolName)) return;
    const call = pending.get(event.toolCallId); pending.delete(event.toolCallId);
    const result = call?.result ?? (call?.dispatched && event.isError ? failure('simulation_result_unknown', 'Execution or cancellation has not been confirmed.', event.toolCallId, call.runId) : undefined);
    if (result) return { ...result, isError: result.details.kind === 'traffic-error' };
  });
  for (const definition of definitions) pi.registerTool({
    name: definition.contract.piName, label: definition.label, description: definition.description,
    parameters: definition.contract.input as unknown as TSchema,
    async execute(toolCallId, params, signal) {
      const call: { dispatched: boolean; runId?: string; result?: Result } = { dispatched: false };
      pending.set(toolCallId, call);
      const invoke = <T>(route: string, input: Record<string, unknown>, timeoutMs: number) => postHostOperation<T>(host(), `/api/internal/traffic/${route}`, input, { toolCallId, contractVersion: definition.contract.contractVersion, signal, timeoutMs, dispatched: () => { call.dispatched = true; } });
      try {
        let input = params as Record<string, unknown>;
        if (definition.route === 'run') {
          const prepared = await invoke<{ runId: string }>('run/prepare', input, 15000);
          if (!/^sim_[a-f0-9]{32}$/.test(prepared.runId)) throw new Error('Invalid Run association');
          call.runId = prepared.runId;
          input = { ...input, operationId: prepared.runId };
        }
        const payload = await invoke<{ result: unknown; canvas?: unknown }>(definition.route, input, definition.route === 'prepare' ? 130000 : definition.route === 'run' ? 75000 : 15000);
        const result = parseTrafficToolResult(payload.result), canvas = payload.canvas === undefined ? undefined : parseCanvasPresentation(payload.canvas);
        if (!result || payload.canvas !== undefined && !canvas) throw new Error('Traffic response could not be validated');
        if (definition.route === 'run' && result.run?.termination !== 'completed') {
          const unknown = result.run?.state !== 'ended';
          call.result = failure(unknown ? 'simulation_result_unknown' : 'traffic_cancelled', result.run?.error?.message || (unknown ? 'Run outcome is not confirmed.' : 'Run was cancelled.'), toolCallId, result.run?.runId);
          if (canvas) call.result.details.canvas = canvas;
          return call.result;
        }
        call.result = { content: [{ type: 'text', text: JSON.stringify(result) }], details: { kind: 'traffic-result', result, ...(canvas ? { canvas } : {}) } };
      } catch (error) {
        const problem = error as Error & { code?: string; commit?: string };
        const code = problem.commit === 'not_started' || problem.commit === 'not_committed' || !call.dispatched ? problem.code || 'traffic_input_invalid' : 'simulation_result_unknown';
        call.result = failure(code, problem.message.slice(0, 1500), toolCallId, call.runId);
      }
      return call.result;
    },
  });
}
