import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession, ModelRecord } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { formatContextWindow, modelReference } from '../../lib/formatting';
import i18n from '../../i18n';

const thinkingLevels = [
  ['off', 'model.thinking.off'],
  ['minimal', 'model.thinking.minimal'],
  ['low', 'model.thinking.low'],
  ['medium', 'model.thinking.medium'],
  ['high', 'model.thinking.high'],
  ['xhigh', 'model.thinking.xhigh'],
] as const;

function normalizeModel(model: ModelRecord | string) {
  const reference = modelReference(model);
  if (typeof model === 'string') return { reference, label: reference, metadata: '' };
  const context = formatContextWindow(model.contextWindow || model.context || model.context_window);
  const abilities = [model.thinking ? i18n.t('model.ability.thinking') : '', model.images ? i18n.t('model.ability.images') : ''].filter(Boolean).join(' · ');
  const metadata = [context ? `${context} context` : '', abilities].filter(Boolean).join(' · ');
  return { reference, label: reference, metadata };
}

export function ModelPickerDialog({ open, onOpenChange, session, onAddModel }: { open: boolean; onOpenChange(open: boolean): void; session: LiveSession | null; onAddModel(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
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
      if (current) setError(t('model.error.list'));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [kernel, open, session, t]);

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
      setError((cause as { message?: string })?.message || t('model.error.update'));
    } finally {
      setSaving(false);
    }
  }

  const normalized = models.map(normalizeModel).filter((item) => item.reference);
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
        {error ? <div className="inline-error" role="alert">{error}</div> : <p className="field-help">{t('model.dialog.help')}</p>}
        <div className="form-actions is-split">
          <Button type="button" variant="outline" onClick={onAddModel}>{t('sessions.addModel')}</Button>
          <span><DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose><Button type="submit" disabled={!session || !model || saving}>{saving ? t('common.saving') : t('common.save')}</Button></span>
        </div>
      </form>
    </Dialog>
  );
}
