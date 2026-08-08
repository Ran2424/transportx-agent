import { useEffect, useState, type FormEvent } from 'react';
import type { LiveSession, ModelRecord } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { modelReference } from '../../lib/formatting';

const thinkingLevels = [
  ['off', '关闭'],
  ['minimal', '极简'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '极高'],
] as const;

function normalizeModel(model: ModelRecord | string) {
  const reference = modelReference(model);
  if (typeof model === 'string') return { reference, label: reference, metadata: '' };
  const context = model.contextWindow || model.context || model.context_window;
  const abilities = [model.thinking ? '思考' : '', model.images ? '图像' : ''].filter(Boolean).join(' · ');
  const metadata = [context ? `${context} context` : '', abilities].filter(Boolean).join(' · ');
  return { reference, label: reference, metadata };
}

export function ModelPickerDialog({ open, onOpenChange, session, onAddModel }: { open: boolean; onOpenChange(open: boolean): void; session: LiveSession | null; onAddModel(): void }) {
  const { kernel } = useAppServices();
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('off');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !session) return;
    let current = true;
    setModel(modelReference(session.model) || session.modelSpec || '');
    setThinking(session.thinkingLevel || 'off');
    setLoading(true);
    setError('');
    Promise.all([
      kernel.commands.platform.getAvailableModels(session.id),
      kernel.commands.agent.getState(session.id),
    ]).then(([available, state]) => {
      if (!current) return;
      setModels(available);
      if (state.model !== undefined) setModel(modelReference(state.model));
      if (state.thinkingLevel) setThinking(state.thinkingLevel);
    }).catch(() => {
      if (current) setError('无法读取模型列表；你仍可保留当前设置。');
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [kernel, open, session]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!session || !model) return;
    setSaving(true);
    setError('');
    try {
      await kernel.commands.agent.setModel({ sessionId: session.id, model });
      await kernel.commands.agent.setThinkingLevel({ sessionId: session.id, level: thinking });
      const slash = model.indexOf('/');
      const nextModel = slash > 0 ? { provider: model.slice(0, slash), id: model.slice(slash + 1) } : model;
      kernel.dispatch({ type: 'session/updated', session: { id: session.id, model: nextModel, modelSpec: model, thinkingLevel: thinking } });
      onOpenChange(false);
    } catch (cause) {
      setError((cause as { message?: string })?.message || '更新模型失败');
    } finally {
      setSaving(false);
    }
  }

  const normalized = models.map(normalizeModel).filter((item) => item.reference);
  if (model && !normalized.some((item) => item.reference === model)) normalized.unshift({ reference: model, label: model, metadata: '当前模型' });
  const modelOptions = normalized.map((item) => ({ value: item.reference, label: item.label, metadata: item.metadata }));
  const thinkingOptions = thinkingLevels.map(([value, label]) => ({ value, label }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="模型与推理" className="model-dialog">
      <form className="form-stack" onSubmit={save}>
        <MenuSelect
          label="模型"
          value={model}
          options={modelOptions}
          placeholder={loading ? '正在读取模型…' : '暂无可用模型'}
          disabled={loading || !session || modelOptions.length === 0}
          autoFocus
          onChange={setModel}
        />
        <MenuSelect
          label="思考级别"
          value={thinking}
          options={thinkingOptions}
          placeholder="选择思考级别"
          compact
          onChange={setThinking}
        />
        {error ? <div className="inline-error" role="alert">{error}</div> : <p className="field-help">可用能力由 Pi 返回的模型目录决定。</p>}
        <div className="form-actions is-split">
          <Button type="button" variant="outline" onClick={onAddModel}>添加模型</Button>
          <span><DialogClose asChild><Button type="button" variant="quiet">取消</Button></DialogClose><Button type="submit" disabled={!session || !model || saving}>{saving ? '正在保存…' : '保存'}</Button></span>
        </div>
      </form>
    </Dialog>
  );
}
