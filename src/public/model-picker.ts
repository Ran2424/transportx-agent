import type { ModelRecord, RpcCommand } from './app-types.js';

type NormalizedModel = {
  provider: string;
  id: string;
  label: string;
  contextWindow?: string | number;
  maxOutput?: string | number;
  thinking?: boolean | string;
  images?: boolean | string;
};

type ModelPickerOptions = {
  getActiveLiveSessionId(): string | null;
  isViewingActiveSession(): boolean;
  rpcCommand(cmd: RpcCommand, statusMsg?: string): Promise<{ success?: boolean; data?: Record<string, unknown>; error?: string }>;
  flashStatusError(message: string, ms?: number): void;
  escapeHtml(text: string): string;
  setContextWindowSize(value: number): void;
  updateContextPill(): void;
};

export function setupModelPicker(options: ModelPickerOptions) {
  const { getActiveLiveSessionId, isViewingActiveSession, rpcCommand, flashStatusError, setContextWindowSize, updateContextPill } = options;

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

// All element lookups below query the app's static index.html shell, which is
// present before this setup function runs; assert non-null at the query site.
const modelInput = document.getElementById('model-input')!;
// Inner label span: the scrollable text container on mobile (buttons are
// unreliable scroll containers, so the text lives in its own element).
const modelInputLabel = document.getElementById('model-input-label')!;
const modelPickerOverlay = document.getElementById('model-picker-overlay')!;
const modelPicker = document.getElementById('model-picker')!;
const modelPickerSelect = document.getElementById('model-picker-select') as HTMLSelectElement;
const modelThinkingSelect = document.getElementById('model-thinking-select') as HTMLSelectElement;
const modelPickerMessage = document.getElementById('model-picker-message')!;
const modelPickerClose = document.getElementById('model-picker-close')!;
const modelPickerCancel = document.getElementById('model-picker-cancel')!;
const modelPickerSave = document.getElementById('model-picker-save')!;
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const MODEL_PICKER_HELP = '从 Pi 已有模型列表中选择；思考级别单独设置。';
let currentModelId: ModelRecord | string = '';
let availableModels: Array<ModelRecord | string> = [];
let currentThinkingLevel = 'off';

function modelDisplayString() {
  if (!currentModelId) return '';
  let provider, modelId;
  if (typeof currentModelId === 'object' && currentModelId) {
    provider = currentModelId.provider || '';
    modelId = currentModelId.id || '';
  } else {
    // Legacy fallback: a bare string is ambiguous when model names contain
    // slashes (e.g. openrouter/z-ai/glm-5.2). Split ONCE on the first slash
    // to separate provider from the rest, because the server normalizes
    // everything into {provider, id} objects before it reaches us.
    const str = String(currentModelId);
    const slashIdx = str.indexOf('/');
    if (slashIdx === -1) {
      provider = '';
      modelId = str;
    } else {
      provider = str.slice(0, slashIdx);
      modelId = str.slice(slashIdx + 1);
    }
  }
  const level = currentThinkingLevel || 'off';
  if (provider && modelId) return `${provider}/${modelId}:${level}`;
  if (modelId) return `${modelId}:${level}`;
  return '';
}

function updateModelDisplay() {
  const display = modelDisplayString() || '模型';
  modelInputLabel.textContent = display;
  modelInput.title = display === '模型' ? '选择本任务使用的模型与思考级别' : display;
  modelInput.classList.remove('invalid');
}

function parseModelSpec(raw: string) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { error: '请使用 provider/model[:thinking] 格式，例如 opencode-go/deepseek-v4-pro:xhigh' };
  }
  // Model IDs can contain slashes (e.g. OpenRouter "z-ai/glm-5.2"), so the
  // input format is provider/<rest...>[:level]. Split on the FIRST slash to
  // separate provider, then split off the optional :level suffix from the end.
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) {
    return { error: '请使用 provider/model[:thinking] 格式，例如 opencode-go/deepseek-v4-pro:xhigh' };
  }
  const provider = trimmed.slice(0, firstSlash);
  const rest = trimmed.slice(firstSlash + 1);
  if (!provider || !rest) {
    return { error: '请使用 provider/model[:thinking] 格式，例如 opencode-go/deepseek-v4-pro:xhigh' };
  }
  let modelId = rest;
  let thinking = null;
  const lastColon = rest.lastIndexOf(':');
  if (lastColon !== -1) {
    const candidate = rest.slice(lastColon + 1).toLowerCase();
    if (VALID_THINKING_LEVELS.has(candidate)) {
      thinking = candidate;
      modelId = rest.slice(0, lastColon);
    }
  }
  if (!modelId) {
    return { error: '请使用 provider/model[:thinking] 格式，例如 opencode-go/deepseek-v4-pro:xhigh' };
  }
  return { provider, modelId, thinking };
}

function normalizeAvailableModel(model: ModelRecord | string): NormalizedModel | null {
  if (!model) return null;
  if (typeof model === 'string') {
    const slashIdx = model.indexOf('/');
    if (slashIdx === -1) return null;
    return { provider: model.slice(0, slashIdx), id: model.slice(slashIdx + 1), label: model, contextWindow: '', maxOutput: '' };
  }
  const provider = model.provider || '';
  const id = model.id || model.model || model.name || '';
  if (!provider || !id) return null;
  return {
    provider,
    id,
    label: `${provider}/${id}`,
    contextWindow: model.contextWindow || model.context || model.context_window || '',
    maxOutput: model.maxOutput || model.max_output || model.maxOut || '',
    thinking: model.thinking,
    images: model.images,
  };
}

function normalizedAvailableModels(): NormalizedModel[] {
  const seen = new Set<string>();
  const out: NormalizedModel[] = [];
  for (const item of availableModels || []) {
    const normalized = normalizeAvailableModel(item);
    if (!normalized) continue;
    const key = `${normalized.provider}/${normalized.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function modelRef(model: { provider?: string; id?: string }) {
  return `${model.provider}/${model.id}`;
}

function setModelPickerMessage(message = MODEL_PICKER_HELP, isError = false) {
  modelPickerMessage.textContent = message;
  modelPickerMessage.classList.toggle('error', isError);
  modelPickerSelect.classList.toggle('invalid', isError);
}

function currentModelRef() {
  if (!currentModelId) return '';
  if (typeof currentModelId === 'object') return modelRef(currentModelId);
  const str = String(currentModelId);
  return str.includes('/') ? str : '';
}

function modelOptionLabel(model: NormalizedModel) {
  const meta = [
    model.contextWindow ? `上下文 ${model.contextWindow}` : '',
    model.maxOutput ? `输出 ${model.maxOutput}` : '',
    model.thinking === true ? '思考' : '',
    model.images === true ? '图像' : '',
  ].filter(Boolean).join(' · ');
  return meta ? `${model.provider}/${model.id}  ·  ${meta}` : `${model.provider}/${model.id}`;
}

function populateModelSelect() {
  const models = normalizedAvailableModels();
  const selected = modelPickerSelect.value || currentModelRef();
  const seen = new Set<string>();
  modelPickerSelect.innerHTML = '';

  for (const model of models) {
    const ref = modelRef(model);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const option = document.createElement('option');
    option.value = ref;
    option.textContent = modelOptionLabel(model);
    modelPickerSelect.appendChild(option);
  }

  if (selected && !seen.has(selected)) {
    const option = document.createElement('option');
    option.value = selected;
    option.textContent = `${selected}  ·  当前模型`;
    modelPickerSelect.insertBefore(option, modelPickerSelect.firstChild);
  }

  if (modelPickerSelect.options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无可用模型';
    modelPickerSelect.appendChild(option);
    modelPickerSave.disabled = true;
    modelPickerSelect.disabled = true;
    setModelPickerMessage('模型列表加载失败或为空，请稍后重试。', true);
    return;
  }

  modelPickerSelect.disabled = false;
  modelPickerSelect.value = selected && Array.from(modelPickerSelect.options).some(option => option.value === selected)
    ? selected
    : modelPickerSelect.options[0].value;
  modelThinkingSelect.value = VALID_THINKING_LEVELS.has(currentThinkingLevel) ? currentThinkingLevel : 'off';
  modelPickerSave.disabled = !modelPickerSelect.value;
  setModelPickerMessage(MODEL_PICKER_HELP, false);
}

function openModelPicker() {
  // The model button is disabled by updateLiveSessionInputState when there is no
  // active live session, so this handler is only reachable via click when a
  // session exists.
  setModelPickerMessage(MODEL_PICKER_HELP, false);
  populateModelSelect();
  modelPicker.classList.remove('hidden');
  modelPickerOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    modelPickerSelect.focus();
  });
  fetchModelInfo().then(() => {
    if (!modelPicker.classList.contains('hidden')) populateModelSelect();
  }).catch(() => {});
}

function closeModelPicker() {
  modelPicker.classList.add('hidden');
  modelPickerOverlay.classList.add('hidden');
  setModelPickerMessage(MODEL_PICKER_HELP, false);
}

async function applyModelSpec(rawSpec: string) {
  const raw = String(rawSpec || '').trim();
  // No-op when the user didn't actually edit anything. Avoids spurious
  // set_model/set_thinking_level RPCs and false validation errors on the
  // current display string.
  if (raw === modelDisplayString()) {
    modelInput.classList.remove('invalid');
    return { success: true };
  }
  if (!isViewingActiveSession() || !getActiveLiveSessionId()) {
    const error = '请先选择一个正在运行的交通任务。';
    flashStatusError(error);
    return { success: false, error };
  }
  const parsed = parseModelSpec(raw);
  if (parsed.error) {
    flashStatusError(parsed.error);
    return { success: false, error: parsed.error };
  }
  const r = await rpcCommand({ type: 'set_model', provider: parsed.provider, modelId: parsed.modelId }, `正在切换到 ${parsed.provider}/${parsed.modelId}...`);
  if (r && r.success) {
    const data = r.data || {};
    // Always retain the provider so modelDisplayString() can render the
    // full `provider/model:thinking` form. The server sometimes omits
    // `provider` in its response; fall back to the user-typed value.
    const responseModel = (typeof data.model === 'object' && data.model ? data.model : data) as ModelRecord;
    const provider = responseModel.provider || parsed.provider;
    const id = responseModel.id || parsed.modelId;
    currentModelId = (provider && id) ? { ...responseModel, provider, id } : (id || parsed.modelId || '');
    const responseContextWindow = responseModel.contextWindow || data.contextWindow;
    if (responseContextWindow) {
      setContextWindowSize(Number(responseContextWindow) || 0);
      updateContextPill();
    }
    if (parsed.thinking !== null) {
      const t = await rpcCommand({ type: 'set_thinking_level', level: parsed.thinking }, '正在设置思考级别...');
      if (t && t.success) {
        currentThinkingLevel = parsed.thinking ?? 'off';
      } else {
        // Non-fatal: the model was already changed on the server.
        // Show the error but still consider the model update successful
        // so the popup closes and the user can retry thinking separately.
        flashStatusError((t && t.error) ? t.error : '设置思考级别失败');
      }
    }
    modelInput.classList.remove('invalid');
    updateModelDisplay();
    return { success: true };
  }
  const error = (r && r.error) ? r.error : '未知模型';
  flashStatusError(error);
  modelInput.classList.add('invalid');
  setTimeout(() => modelInput.classList.remove('invalid'), 1200);
  return { success: false, error };
}

async function saveModelPicker() {
  const selectedModel = modelPickerSelect.value;
  if (!selectedModel) {
    setModelPickerMessage('请先选择一个模型。', true);
    modelPickerSelect.focus();
    return;
  }
  const result = await applyModelSpec(`${selectedModel}:${modelThinkingSelect.value || 'off'}`);
  if (result.success) {
    closeModelPicker();
  } else {
    setModelPickerMessage(result.error || '更新模型失败', true);
    modelPickerSelect.focus();
  }
}

modelInput.addEventListener('click', openModelPicker);
modelPickerOverlay.addEventListener('click', closeModelPicker);
modelPickerClose.addEventListener('click', closeModelPicker);
modelPickerCancel.addEventListener('click', closeModelPicker);
modelPickerSave.addEventListener('click', saveModelPicker);
modelPickerSelect.addEventListener('change', () => setModelPickerMessage(MODEL_PICKER_HELP, false));
modelThinkingSelect.addEventListener('change', () => setModelPickerMessage(MODEL_PICKER_HELP, false));
modelPicker.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeModelPicker();
    return;
  }
  if (e.key === 'Enter' && e.target !== modelPickerSelect && e.target !== modelThinkingSelect) {
    e.preventDefault();
    saveModelPicker();
  }
});

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models', sessionId: getActiveLiveSessionId() }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state', sessionId: getActiveLiveSessionId() }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model !== undefined) {
      // Server is canonical: stateData.data.model is null or a full
      // {provider,id} object. Assign directly — no string fallback.
      currentModelId = stateData.data.model || '';
      if (stateData.data.model?.contextWindow) {
        setContextWindowSize(Number(stateData.data.model.contextWindow) || 0);
        updateContextPill();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel || 'off';
    }
    updateModelDisplay();
  } catch (e) {
    // ignore
  }
}

  function setModelState(model: ModelRecord | string | null, thinkingLevel = 'off') {
    currentModelId = model || '';
    currentThinkingLevel = thinkingLevel || 'off';
    updateModelDisplay();
  }

  function setThinkingLevel(level: string) {
    currentThinkingLevel = level || 'off';
    updateModelDisplay();
  }

  function setEnabled(enabled: boolean) {
    modelInput.disabled = !enabled;
  }

  function closeIfOpen() {
    if (modelPicker.classList.contains('hidden')) return false;
    closeModelPicker();
    return true;
  }

  return { applyModelSpec, closeIfOpen, fetchModelInfo, setEnabled, setModelState, setThinkingLevel, updateModelDisplay };
}
