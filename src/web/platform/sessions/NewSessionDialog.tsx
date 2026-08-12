import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRecord } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { MenuSelect } from '../../components/ui/menu-select';
import { modelReference } from '../../lib/formatting';
import i18n from '../../i18n';

type NewSessionDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(sessionId: string): void;
  onAddModel(): void;
};

function normalizeModel(model: ModelRecord | string) {
  if (typeof model === 'string') return { value: model, label: model, metadata: '' };
  const reference = modelReference(model);
  const context = model.contextWindow || model.context || model.context_window;
  const abilities = [model.thinking ? i18n.t('model.ability.thinking') : '', model.images ? i18n.t('model.ability.images') : ''].filter(Boolean).join(' · ');
  return {
    value: reference,
    label: reference,
    metadata: [context ? `${context} context` : '', abilities].filter(Boolean).join(' · '),
  };
}

export function NewSessionDialog({ open, onOpenChange, onCreated, onAddModel }: NewSessionDialogProps) {
  const { t } = useTranslation();
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
      setError((cause as { message?: string })?.message || t('sessions.createFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  const modelOptions = models.map(normalizeModel).filter((item) => item.value);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sessions.newTask')}
      className="new-session-dialog"
      footer={null}
    >
      <form className="form-stack" onSubmit={submit}>
        <div className="field-with-action">
          <MenuSelect
            label={t('sessions.model')}
            value={model}
            options={modelOptions}
            placeholder={loadingModels ? t('sessions.loadingModels') : t('sessions.noModels')}
            disabled={loadingModels || modelOptions.length === 0}
            autoFocus={modelOptions.length > 0}
            onChange={setModel}
          />
          <Button type="button" variant="outline" onClick={onAddModel}>{t('sessions.addModel')}</Button>
        </div>
        <p className="field-help">{t('sessions.workspaceHelp')}</p>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
          <Button type="submit" disabled={submitting || !model}>{submitting ? t('sessions.starting') : t('sessions.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
