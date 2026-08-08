import { useEffect, useState, type FormEvent } from 'react';
import type { PiModelApi } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';

const apiOptions: Array<{ value: PiModelApi; label: string; metadata: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses', metadata: 'OpenAI 及兼容 Responses 服务' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions', metadata: 'Ollama、LM Studio、vLLM 及兼容服务' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', metadata: 'Anthropic 及兼容代理' },
  { value: 'google-generative-ai', label: 'Google Generative AI', metadata: 'Google AI Studio 及兼容服务' },
];

export function ModelSetupDialog({ open, onOpenChange, onConfigured }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfigured(reference: string): void;
}) {
  const { kernel } = useAppServices();
  const [provider, setProvider] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [api, setApi] = useState<PiModelApi>('openai-responses');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [reasoning, setReasoning] = useState(false);
  const [images, setImages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setApiKey('');
    setError('');
  }, [open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await kernel.commands.platform.addModel({ provider, modelId, name, api, baseUrl, apiKey, reasoning, images });
      setProvider('');
      setModelId('');
      setName('');
      setBaseUrl('');
      setApiKey('');
      setReasoning(false);
      setImages(false);
      onConfigured(result.reference);
    } catch (cause) {
      setError((cause as { message?: string })?.message || '添加模型失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="添加 Pi 模型" className="model-setup-dialog">
      <form className="form-stack" onSubmit={save}>
        <div className="form-grid-two">
          <label className="field-label"><span>Provider ID</span><input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="例如 openai" autoFocus required /></label>
          <label className="field-label"><span>Model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如 gpt-5.6" required /></label>
        </div>
        <label className="field-label"><span>显示名称（可选）</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="便于识别的模型名称" /></label>
        <MenuSelect label="Pi API 类型" value={api} options={apiOptions} placeholder="选择 API 类型" onChange={(value) => setApi(value as PiModelApi)} />
        <label className="field-label"><span>API Base URL</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
        <label className="field-label"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="仅保存在本机 auth.json" autoComplete="new-password" required /></label>
        <div className="model-capability-row">
          <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />支持推理</label>
          <label><input type="checkbox" checked={images} onChange={(event) => setImages(event.target.checked)} />支持图像输入</label>
        </div>
        <p className="field-help">模型配置保存在 TransportX 本地目录。新增模型会在新建任务时加载。</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">取消</Button></DialogClose>
          <Button type="submit" disabled={saving || !provider.trim() || !modelId.trim() || !baseUrl.trim() || !apiKey.trim()}>{saving ? '正在保存…' : '保存模型'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
