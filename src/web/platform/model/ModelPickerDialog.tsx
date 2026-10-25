import { ModelRefreshButton } from './ModelRefreshButton';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationView, ModelRecord } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { formatModelOption, modelReference } from '../../lib/formatting';

const thinkingLevels = [
  ['off', 'model.thinking.off'],
  ['minimal', 'model.thinking.minimal'],
  ['low', 'model.thinking.low'],
  ['medium', 'model.thinking.medium'],
  ['high', 'model.thinking.high'],
  ['xhigh', 'model.thinking.xhigh'],
] as const;

export function ModelPickerDialog({ open, onOpenChange, session, onAddModel }: { open: boolean; onOpenChange(open: boolean): void; session: ConversationView | null; onAddModel(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('off');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
    }).catch((cause) => {
      if (current) setError((cause as { message?: string })?.message || t('model.error.list'));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [kernel, open, session?.id, t]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!session || !model) return;
    setSaving(true);
    setError('');
    try {
      await kernel.commands.agent.setModel({ sessionId: session.id, model });
      await kernel.commands.agent.setThinkingLevel({ sessionId: session.id, level: thinking });
      const state = await kernel.commands.agent.getState(session.id);
      kernel.dispatch({ type: 'session/updated', session: { id: session.id, model: state.model, thinkingLevel: state.thinkingLevel } });
      onOpenChange(false);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('model.error.update'));
    } finally {
      setSaving(false);
    }
  }

  const normalized = models.map(formatModelOption).filter((item) => item.reference);
  if (model && !normalized.some((item) => item.reference === model)) normalized.unshift({ reference: model, label: model, metadata: t('model.current') });
  const modelOptions = normalized.map((item) => ({ value: item.reference, label: item.label, metadata: item.metadata }));
  const thinkingOptions = thinkingLevels.map(([value, label]) => ({ value, label: t(label) }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('model.dialog.title')} className="model-dialog">
      <form className="form-stack" onSubmit={save}>
        <MenuSelect
          label={t('sessions.model')}
          value={model}
          options={modelOptions}
          placeholder={loading ? t('sessions.loadingModels') : t('model.dialog.noModels')}
          disabled={loading || !session || modelOptions.length === 0}
          autoFocus
          onChange={setModel}
        />
        <MenuSelect
          label={t('model.dialog.thinkingLevel')}
          value={thinking}
          options={thinkingOptions}
          placeholder={t('model.dialog.selectThinking')}
          compact
          onChange={setThinking}
        />
        <ModelRefreshButton key={session?.id} sessionId={session?.id} disabled={loading || saving} onModels={(next) => { setModels(next); setError(''); }} onBusy={setRefreshing} />
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions is-split">
          <Button type="button" variant="outline" onClick={onAddModel}>{t('sessions.addModel')}</Button>
          <span><DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose><Button type="submit" disabled={!session || !model || saving || refreshing}>{saving ? t('common.saving') : t('common.save')}</Button></span>
        </div>
      </form>
    </Dialog>
  );
}
