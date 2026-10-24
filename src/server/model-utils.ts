import type { ModelIdentity, ParsedModelSpec } from './types.js';
import { listAvailablePiModels } from './pi-model-access.js';

export function modelLabel(model: ModelIdentity | string | null | undefined, fallback = '') {
  if (!model) return fallback || '';
  if (typeof model === 'string') return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.id || model.name || fallback || '';
}

// Normalize any model value into the canonical form: null or a full
// {provider, id, ...} object. Bare `provider/id` strings (and "id" strings
// with no slash) are parsed into objects; anything unrecognizable becomes null.
export function normalizeModel(value: unknown): ModelIdentity | null {
  if (!value) return null;
  if (typeof value === 'object') {
    const record = value as ModelIdentity;
    if (record.provider && record.id) return { ...record };
    if (record.id) return { ...record, provider: record.provider || '' };
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx === -1) return { provider: '', id: trimmed };
    const provider = trimmed.slice(0, slashIdx);
    const id = trimmed.slice(slashIdx + 1);
    if (!id) return null;
    return { provider, id };
  }
  return null;
}

// Parse a `provider/id[:level]` spec string (as passed on session creation or
// the model-input box) into a canonical {provider, id} object plus an optional
// thinking level. Returns {model, level} where `model` is null when unparseable.
export function parseModelSpecToModel(spec: unknown): ParsedModelSpec {
  const trimmed = String(spec || '').trim();
  if (!trimmed) return { model: null, level: null };
  let level = null;
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    const candidate = trimmed.slice(colonIdx + 1).toLowerCase();
    if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(candidate)) {
      level = candidate;
    }
  }
  const core = (colonIdx !== -1 && level) ? trimmed.slice(0, colonIdx) : trimmed;
  return { model: normalizeModel(core), level };
}

export function getAvailableModels() {
  return listAvailablePiModels(require('./config.js').PI_AGENT_DIR);
}
