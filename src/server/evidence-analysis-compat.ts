import type { ResolvedSessionPlan } from './session-assembly.js';

// Archived module versions read the old boolean instead of the session task context.
export function legacyEvidenceAnalysisEnvironment(plan: ResolvedSessionPlan): NodeJS.ProcessEnv {
  const legacy = plan.modules.some((module) => module.id === 'com.transportx.evidence-analysis' &&
    (module.version === '1.0.0' || module.version === '1.1.0'));
  const task = plan.profile?.task;
  return {
    TAU_EVIDENCE_ANALYSIS_REQUIRED: legacy && task?.kind === 'data-query' && task.expectedOutputs?.includes('answer')
      ? '1'
      : undefined,
  };
}
