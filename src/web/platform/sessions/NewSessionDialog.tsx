import { useEffect, useState, type FormEvent } from 'react';
import type { ModelRecord } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { modelReference } from '../../lib/formatting';

type NewSessionDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string): void;
};

function normalizeModel(model: ModelRecord | string) {
  if (typeof model === 'string') return { value: model, label: model, metadata: '' };
  const reference = modelReference(model);
  const context = model.contextWindow || model.context || model.context_window;
  const abilities = [model.thinking ? '思考' : '', model.images ? '图像' : ''].filter(Boolean).join(' · ');
  return {
    value: reference,
    label: reference,
    metadata: [context ? `${context} context` : '', abilities].filter(Boolean).join(' · '),
  };
}

export function NewSessionDialog({ open, onOpenChange, onCreated }: NewSessionDialogProps) {
  const { kernel } = useAppServices();
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
    setSubmitting(true);
    setError('');
    try {
      const session = await kernel.commands.session.create({ model });
      kernel.dispatch({ type: 'session/created', session });
      setModel('');
      onOpenChange(false);
      onCreated(session.id);
    } catch (cause) {
      setError((cause as { message?: string })?.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  const modelOptions = [
    { value: '', label: '使用 Pi 默认模型', metadata: '继承 Pi 的启动配置' },
    ...models.map(normalizeModel).filter((item) => item.value),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建交通任务"
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        <MenuSelect
          label="模型"
          value={model}
          options={modelOptions}
          placeholder={loadingModels ? '正在读取模型…' : '使用 Pi 默认模型'}
          disabled={loadingModels}
          autoFocus
          onChange={setModel}
        />
        <p className="field-help">工作区按创建时间自动生成；模型稍后仍可从顶部状态栏切换。</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">取消</Button></DialogClose>
          <Button type="submit" disabled={submitting}>{submitting ? '正在启动…' : '创建任务'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
