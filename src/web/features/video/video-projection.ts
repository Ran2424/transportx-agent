import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';
import { getVideoSceneFromToolResult, type VideoEnvelopeV1 } from '../../../contracts/video.js';

/**
 * Project the newest Video Scene from the session history (tool-result
 * envelopes) and live tool executions. The scene is the single source of
 * truth; player transient state never leaves the React component.
 */
export function projectVideoScene(entries: SessionEntry[], executions: ToolExecution[]): VideoEnvelopeV1 | null {
  let latest: VideoEnvelopeV1 | null = null;
  const accept = (value: unknown) => {
    const envelope = getVideoSceneFromToolResult(value);
    if (envelope && (!latest || envelope.revision >= latest.revision)) latest = envelope;
  };
  entries.forEach((entry) => accept(entry.message));
  executions.forEach((execution) => accept(execution.result));
  return latest;
}
