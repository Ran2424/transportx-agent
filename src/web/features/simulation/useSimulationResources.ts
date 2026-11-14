import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SimulationRunSummary, SimulationIndex, SimulationFrame, SimulationNetworkView, SimulationQuery, SimulationBlock, SimulationExperiment } from '../../../contracts/simulation';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';

type ResourceInputs = {
  kernel: CanvasRendererProps['kernel'];
  sessionId: string;
  runId: string;
  experimentId?: string;
  active: boolean;
  time: number;
  selected: string;
  eventSequence?: number;
  onContextChange: CanvasRendererProps['onContextChange'];
};
export const simulationResourceLabels = { experiment: '实验比较', index: '运行索引', geometry: '路网', chunk: '位置帧', query: '对象查询' };
type Resource = keyof typeof simulationResourceLabels;
const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export function useSimulationResources({ kernel, sessionId, runId, experimentId, active, time, selected, eventSequence, onContextChange }: ResourceInputs) {
  const [errors, setErrors] = useState<Partial<Record<Resource, string>>>({});
  const [pending, setPending] = useState<Partial<Record<Resource, boolean>>>({});
  const markPending = (kind: Resource, value: boolean) => setPending(previous => (previous[kind] ?? false) === value ? previous : { ...previous, [kind]: value });
  const [attempts, setAttempts] = useState<Partial<Record<Resource, number>>>({});
  const retry = (kind: Resource) => setAttempts(previous => ({ ...previous, [kind]: (previous[kind] ?? 0) + 1 }));
  const setError = (kind: Resource, error: string) => setErrors(previous => (previous[kind] ?? '') === error ? previous : { ...previous, [kind]: error });
  const [run, setRun] = useState<SimulationRunSummary>();
  const [index, setIndex] = useState<SimulationIndex | null>(null);
  const [geometry, setGeometry] = useState<SimulationNetworkView>();
  const [loaded, setLoaded] = useState<{ time: number; frame: SimulationFrame; sampleSeconds: number }>();
  const frame = loaded?.frame;
  const [queryResult, setQueryResult] = useState<{ data: SimulationQuery; selected: string; eventSequence?: number }>();
  const [experiment, setExperiment] = useState<SimulationExperiment>();
  const currentFrame = loaded?.time === time ? frame : undefined;
  const frameQuery = queryResult?.data.requestedTime === time && queryResult.data.time === currentFrame?.time ? queryResult.data : undefined;
  const query = queryResult?.selected === selected && queryResult.eventSequence === eventSequence ? frameQuery : undefined;
  const cache = useRef(new Map<string, SimulationBlock>()), contextCallback = useRef(onContextChange);
  contextCallback.current = onContextChange;
  const subscribeSession = useCallback((changed: () => void) => kernel.stores.session.subscribe(changed), [kernel]);
  const notice = useSyncExternalStore(subscribeSession, () => kernel.stores.session.get().simulationBySession?.[sessionId]);
  const subscribeRuntime = useCallback((changed: () => void) => kernel.stores.runtime.subscribe(changed), [kernel]);
  const connection = useSyncExternalStore(subscribeRuntime, () => kernel.stores.runtime.get().connection);
  const commands = kernel.commands.simulation;
  useEffect(() => {
    if (!active || !experimentId) return;
    const controller = new AbortController();
    markPending('experiment', true);
    void commands.experiment(sessionId, experimentId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.experimentId !== experimentId) throw new Error('实验比较与当前实验不一致');
      setExperiment(value); setError('experiment', '');
    }).catch(cause => { if (!controller.signal.aborted) setError('experiment', message(cause)); })
      .finally(() => { if (!controller.signal.aborted) markPending('experiment', false); });
    return () => controller.abort();
  }, [active, sessionId, experimentId, notice?.runUpdatedAt, connection, attempts.experiment, commands]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    markPending('index', true);
    void commands.index(sessionId, runId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      if (value.run.runId !== runId || value.index && value.index.runId !== runId) throw new Error('索引与当前运行不一致');
      setRun(value.run); setError('index', '');
      setIndex((previous) => previous && (!value.index || previous.revision > value.index.revision) ? previous : value.index);
    }).catch((cause) => { if (!controller.signal.aborted) setError('index', message(cause)); }).finally(() => { if (!controller.signal.aborted) markPending('index', false); });
    return () => controller.abort();
  }, [active, sessionId, runId, notice?.canvas.viewId === `simulation:${runId}` ? notice.runUpdatedAt : '', connection, attempts.index, commands]);

  useEffect(() => {
    if (!active || geometry) return;
    const controller = new AbortController();
    markPending('geometry', true);
    void commands.geometry(sessionId, runId, controller.signal).then((value) => { if (!controller.signal.aborted) { setGeometry(value); setError('geometry', ''); } }).catch((cause) => { if (!controller.signal.aborted) setError('geometry', message(cause)); }).finally(() => { if (!controller.signal.aborted) markPending('geometry', false); });
    return () => controller.abort();
  }, [active, sessionId, runId, geometry, commands, attempts.geometry]);

  useEffect(() => {
    if (!active || !index?.chunks.length) { markPending('chunk', false); return; }
    const sequence = index.chunks.reduce((found, entry, i) => entry.from <= time ? i : found, -1);
    if (sequence < 0) { markPending('chunk', false); return; }
    const controller = new AbortController();
    const apply = (block: SimulationBlock) => {
      if (controller.signal.aborted || block.runId !== runId || block.networkSha256 !== index.networkSha256 || block.sequence !== sequence) return;
      const next = [...block.frames].reverse().find((item) => item.time <= time) || block.start;
      if (next.time <= time) { setLoaded({ time, frame: next, sampleSeconds: block.sampleSeconds }); setError('chunk', ''); }
    };
    const chunkKey = index.chunks[sequence].sha256;
    const cached = cache.current.get(chunkKey);
    if (cached) { apply(cached); markPending('chunk', false); }
    else {
      markPending('chunk', true);
      void commands.chunk(sessionId, runId, sequence, controller.signal).then(({ block }) => {
        if (controller.signal.aborted) return;
        if (block.runId !== runId || block.networkSha256 !== index.networkSha256 || block.sequence !== sequence) throw new Error('位置帧与当前运行不一致');
        cache.current.set(chunkKey, block);
        while (cache.current.size > 3) cache.current.delete(cache.current.keys().next().value!);
        apply(block);
      }).catch((cause) => { if (!controller.signal.aborted) setError('chunk', message(cause)); })
        .finally(() => { if (!controller.signal.aborted) markPending('chunk', false); });
    }
    return () => controller.abort();
  }, [active, time, index, runId, sessionId, commands, attempts.chunk]);

  useEffect(() => {
    if (!active) return;
    contextCallback.current();
    if (!frame || loaded?.time !== time) { markPending('query', false); return; }
    const controller = new AbortController();
    markPending('query', true);
    void commands.query(sessionId, runId, time, selected || undefined, controller.signal, eventSequence).then((value) => {
      if (controller.signal.aborted) return;
      if (value.runId !== runId || value.time !== frame.time || value.requestedTime !== time) throw new Error('查询结果与当前观看时刻不一致');
      setQueryResult({ data: value, selected, eventSequence }); setError('query', '');
      contextCallback.current({ time, ...(selected ? { objectId: selected } : {}), ...(eventSequence === undefined ? {} : { eventSequence }) });
    }).catch((cause) => { if (!controller.signal.aborted) setError('query', message(cause)); }).finally(() => { if (!controller.signal.aborted) markPending('query', false); });
    return () => { controller.abort(); contextCallback.current(); };
  }, [active, loaded, frame, selected, eventSequence, time, runId, sessionId, commands, attempts.query]);

  return { run, index, geometry, loaded, frame, currentFrame, frameQuery, query, experiment: experiment?.experimentId === experimentId ? experiment : undefined, errors, pending, retry };
}
