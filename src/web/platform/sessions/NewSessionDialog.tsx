import { useEffect, useState, type FormEvent } from 'react';
import type { ModelRecord } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { modelReference } from '../../lib/formatting';

type NewSessionDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string): void;
};

function modelLabel(model: ModelRecord | string) {
  if (typeof model === 'string') return model;
  const reference = modelReference(model);
  const context = model.contextWindow || model.context || model.context_window;
  return context ? `${reference} · ${context} context` : reference;
}

export function NewSessionDialog({ open, onOpenChange, onCreated }: NewSessionDialogProps) {
  const { kernel } = useAppServices();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    setLoadingModels(true);
    kernel.commands.platform.getAvailableModels(kernel.stores.session.get().activeSessionId)
      .then((items) => { if (current) setModels(items); })
      .catch(() => { if (current) setModels([]); })
      .finally(() => { if (current) setLoadingModels(false); });
    return () => { current = false; };
  }, [kernel, open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSubmitting(true);
    setError('');
    try {
      // Deliberately omit cwd: the server owns the default task root and
      // creates the timestamped scenario directory.
      const session = await kernel.commands.session.create({ name: trimmedName, model });
      kernel.dispatch({ type: 'session/created', session });
      setName('');
      setModel('');
      onOpenChange(false);
      onCreated(session.id);
    } catch (cause) {
      setError((cause as { message?: string })?.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建交通任务"
      eyebrow="NEW AGENT RUN"
      description="服务端会在受管 scenario 根目录下创建独立、带时间戳的任务目录。"
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">
          <span>任务名称</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：早高峰拥堵分析" required />
        </label>
        <label className="field-label">
          <span>模型</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={loadingModels}>
            <option value="">{loadingModels ? '正在读取模型…' : '使用 Pi 默认模型'}</option>
            {models.map((item) => {
              const value = modelReference(item);
              return value ? <option value={value} key={value}>{modelLabel(item)}</option> : null;
            })}
          </select>
        </label>
        <p className="field-help">模型仅作用于当前任务；稍后仍可从顶部状态栏切换。</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">取消</Button></DialogClose>
          <Button type="submit" disabled={submitting || !name.trim()}>{submitting ? '正在启动…' : '创建任务'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
