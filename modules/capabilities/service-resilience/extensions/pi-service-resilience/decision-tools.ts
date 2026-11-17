import patch from 'fast-json-patch';
import type { Static } from 'typebox';
import type {
  ResilienceAccessibilitySchema, ResilienceComparePlansSchema, ResilienceEventAlignmentSchema, ResilienceJointSensitivitySchema,
} from '../../../../../src/contracts/tool-definitions.mts';
import { assessAccessibility } from './accessibility.ts';
import { scanJointSensitivity } from './joint-sensitivity.ts';
import { defineComparison, type ConfirmedChange } from './plan-comparison.ts';
import { alignSpatiotemporal } from './spatiotemporal.ts';
import { method, loadCase, runWorkspaceCase } from './workspace-run.ts';
import { digest, jsonBytes, publish, readInput } from './workspace-files.ts';

export type EventInputs = Static<typeof ResilienceEventAlignmentSchema>;
export type PlanInputs = Static<typeof ResilienceComparePlansSchema>;
export type AccessInputs = Static<typeof ResilienceAccessibilitySchema>;
export type SensitivityInputs = Static<typeof ResilienceJointSensitivitySchema>;

export function publishJson(cwd: string, suffix: string, value: unknown) {
  const body = jsonBytes(value);
  return publish(cwd, 'resilience-' + digest(body).slice(0, 20) + '-' + suffix, body);
}

function eventAlignment(cwd: string, { eventPath, calendarPath, toleranceMeters = 20 }: EventInputs,
  { model, inputs, notes }: ReturnType<typeof loadCase>) {
  const event = readInput(cwd, eventPath), calendar = readInput(cwd, calendarPath);
  return {
    protocol: 'transportx-resilience-event-alignment', version: 1, method, provenance: model.provenance, notes,
    inputs: [...inputs, { role: 'events', path: eventPath, sha256: event.sha256 }, { role: 'calendar', path: calendarPath, sha256: calendar.sha256 }],
    criteria: { eventPath, calendarPath, toleranceMeters },
    ...alignSpatiotemporal(model, JSON.parse(event.text), JSON.parse(calendar.text), toleranceMeters),
  };
}

export function publishEventAlignment(cwd: string, args: EventInputs) {
  const data = eventAlignment(cwd, args, loadCase(cwd, args.casePath));
  const file = publishJson(cwd, 'event-alignment.json', data);
  return { ...file, summary: data.summary, confirmedChanges: data.confirmedChanges.slice(0, 100) };
}

function readReviewedChanges(cwd: string, source: ReturnType<typeof loadCase>, binding: NonNullable<PlanInputs['alignment']>) {
  const evidence = readInput(cwd, binding.path);
  if (evidence.sha256 !== binding.sha256) throw new Error('Alignment evidence hash mismatch.');
  const stored = JSON.parse(evidence.text);
  if (stored?.protocol !== 'transportx-resilience-event-alignment' || stored.version !== 1 ||
      typeof stored.criteria?.eventPath !== 'string' || typeof stored.criteria?.calendarPath !== 'string' ||
      typeof stored.criteria?.toleranceMeters !== 'number') throw new Error('Expected a generated event-alignment artifact.');
  const rebuilt = eventAlignment(cwd, { eventPath: stored.criteria.eventPath, calendarPath: stored.criteria.calendarPath,
    toleranceMeters: stored.criteria.toleranceMeters }, source);
  if (digest(jsonBytes(rebuilt)) !== evidence.sha256) throw new Error('Alignment evidence, source files or base case have changed.');
  const changes = rebuilt.confirmedChanges.filter(change => binding.eventIds.includes(change.eventId));
  if (new Set(changes.map(change => change.eventId)).size !== binding.eventIds.length) {
    throw new Error('Every reviewed event must have a confirmed exact match covering a full analysis period.');
  }
  return changes;
}

export function comparePlans(cwd: string, { casePath, planPath, alignment, ...view }: PlanInputs, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = loadCase(cwd, casePath);
  const { model, inputs, notes } = source;
  const input = readInput(cwd, planPath);
  const changes: ConfirmedChange[] = alignment ? readReviewedChanges(cwd, source, alignment) : [];
  const next = defineComparison(model, JSON.parse(input.text), changes, alignment?.stateId);
  const base = publishJson(cwd, 'comparison-base.json', model);
  const derived = publishJson(cwd, 'comparison-case.json', next);
  const appliedEventIds = [...new Set(changes.map(change => change.eventId))];
  const definition = publishJson(cwd, 'plan-definition.json', {
    protocol: 'transportx-resilience-plan-definition', version: 1, method, provenance: model.provenance, notes,
    inputs: [...inputs, { role: 'plans', path: planPath, sha256: input.sha256 },
      ...(alignment ? [{ role: 'alignment', path: alignment.path, sha256: alignment.sha256 }] : [])],
    base, derived, alignment: alignment ?? null, appliedEventIds,
    patch: patch.compare(model, next),
  });
  const result = runWorkspaceCase(cwd, derived.path, view, signal, derived.sha256);
  return { definition, appliedEventIds, ...result };
}

export function publishAccessibility(cwd: string, { casePath, caseSha256, ...view }: AccessInputs, signal?: AbortSignal) {
  const { model, inputs, notes } = loadCase(cwd, casePath, caseSha256);
  const { map, ...result } = assessAccessibility(model, view, signal);
  const mapFile = publishJson(cwd, 'accessibility.geojson', { ...map, ...(notes.length ? { notes } : {}) });
  const file = publishJson(cwd, 'accessibility.json', { protocol: 'transportx-resilience-accessibility', version: 1,
    method, provenance: model.provenance, inputs, notes, ...result, map: mapFile });
  return { ...file, map: mapFile, summary: result.summary };
}

export function publishJointSensitivity(cwd: string, { casePath, caseSha256, ...request }: SensitivityInputs) {
  const { model, inputs, notes } = loadCase(cwd, casePath, caseSha256);
  const result = scanJointSensitivity(model, request);
  const file = publishJson(cwd, 'joint-sensitivity.json', { protocol: 'transportx-resilience-joint-sensitivity', version: 1,
    method, provenance: model.provenance, inputs, notes, ...result });
  return { ...file, pointCount: result.points.length, transitionCount: result.transitions.length,
    interactionCount: result.interactions.length, candidateQuestions: result.candidateQuestions.map(item => item.question).slice(0, 12) };
}
