import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession, SessionAttachment } from '../../../public/app-types.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { Icon } from '../../components/icons';
import { AttachmentCards } from './conversation-attachments';
import { ComposerAttachmentList, useComposerAttachments } from './composer-attachments';
import { ComposerContextUsage } from './composer-context-usage';
import { ComposerCitationPicker, useComposerCitationPicker } from './composer-citation-picker';

export function ConversationComposer({ sessionId, session, streaming, compacting, queued, taskModeEnabled, attachments, onCitationEnvelope, onOpenCitationManager }: { sessionId: string; session: LiveSession | undefined; streaming: boolean; compacting: boolean; queued: Array<{ message: string; attachmentIds?: string[] }>; taskModeEnabled: boolean; attachments: Record<string, SessionAttachment>; onCitationEnvelope(citations: CitationEnvelope): void; onOpenCitationManager(): void; }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const { pending, setPending, addAttachments, removeAttachment } = useComposerAttachments(sessionId, setError);
  const [taskModeBusy, setTaskModeBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { citeOpen, citeLoading, citeCandidates, setCiteOpen, openCitePicker, insertCitation } = useComposerCitationPicker({ sessionId, onCitationEnvelope, onInsert: (marker) => setValue((current) => current.replace('/cite', marker)), onError: setError, onFocus: () => inputRef.current?.focus() });
  const resize = () => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; } };
  useEffect(resize, [value]);
  async function submit(mode: 'prompt' | 'steer' = streaming ? 'steer' : 'prompt') {
    const attachmentIds = pending.filter((item) => item.status === 'ready' && item.attachment).map((item) => item.attachment!.id);
    if (pending.some((item) => item.status === 'uploading')) { setError(t('conversation.uploadingWait')); return; }
    const message = value.trim() || (attachmentIds.length ? t('conversation.attachmentOnly') : '');
    if (!message) return;
    try { if (mode === 'steer') await kernel.commands.agent.steer({ sessionId, message, attachmentIds }); else await kernel.commands.agent.sendPrompt({ sessionId, message, attachmentIds }); setValue(''); setPending([]); } catch (cause) { setError((cause as Error).message || t('conversation.sendFailed')); }
  }
  async function toggleTaskMode() {
    if (streaming || compacting || taskModeBusy) return;
    setTaskModeBusy(true);
    setError('');
    try {
      await kernel.commands.agent.setTaskMode({ sessionId, enabled: !taskModeEnabled });
    } catch (cause) {
      setError((cause as Error).message || t('conversation.toggleTaskFailed'));
    } finally {
      setTaskModeBusy(false);
    }
  }
  return <footer className="conversation-composer">
    <div className="queued-prompts">{queued.map((item, index) => <div key={`${item.message}-${index}`}><span>{t('conversation.queued')}</span><p>{item.message}</p><AttachmentCards sessionId={sessionId} attachmentIds={item.attachmentIds} attachments={attachments} compact /><button type="button" aria-label={t('conversation.cancelQueued')} onClick={() => kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId, index })}>×</button></div>)}</div>
    <ComposerAttachmentList sessionId={sessionId} pending={pending} onRemove={(item) => void removeAttachment(item)} />
    <div className="composer-row">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => { const next = event.target.value; setValue(next); if (next.includes('/cite') && !citeOpen) void openCitePicker(); if (!next.includes('/cite')) setCiteOpen(false); }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            const images = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
            const attachments = files.length ? files : images;
            if (attachments.length) { event.preventDefault(); void addAttachments(attachments, 'clipboard'); }
          }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addAttachments(event.dataTransfer.files, 'drop'); } }}
          onDragOver={(event) => event.preventDefault()}
          onKeyDown={(event) => { if (event.key === 'Escape' && citeOpen) { event.preventDefault(); setCiteOpen(false); return; } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          placeholder={streaming ? t('conversation.steerPlaceholder') : t('conversation.promptPlaceholder')}
          aria-label={t('conversation.messageInput')}
          disabled={compacting}
        />
        {citeOpen ? <ComposerCitationPicker loading={citeLoading} candidates={citeCandidates} onClose={() => setCiteOpen(false)} onSelect={(locatorId) => void insertCitation(locatorId)} /> : null}
        <div className="composer-toolbar">
          <div className="composer-action-rail">
            <label className="composer-attach">
              <Icon name="plus" />
              <span className="composer-action-hint" aria-hidden="true">{t('conversation.addAttachment')}</span>
              <span className="sr-only">{t('conversation.addAttachment')}</span>
              <input type="file" accept="*/*" multiple onChange={(event) => { if (event.currentTarget.files) void addAttachments(event.currentTarget.files, 'picker'); event.currentTarget.value = ''; }} />
            </label>
            <button className={`composer-task-toggle${taskModeEnabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={taskModeEnabled} aria-label={taskModeEnabled ? t('task.mode.disable') : t('task.mode.enable')} disabled={streaming || compacting || taskModeBusy} onClick={() => void toggleTaskMode()}>
              <Icon name="task" />
              <span className="composer-action-hint" aria-hidden="true">{taskModeEnabled ? t('task.mode.disable') : t('task.mode.enable')}</span>
            </button>
            <button className="composer-task-toggle" type="button" aria-label={t('conversation.openCitationManager')} onClick={onOpenCitationManager}><Icon name="citation" /><span className="composer-action-hint" aria-hidden="true">{t('conversation.citationManager')}</span></button>
            <ComposerContextUsage session={session} />
          </div>
          {compacting
            ? <span className="composer-compacting" role="status">{t('conversation.compacting')}</span>
            : streaming
            ? <div className="composer-stream-actions"><button className="composer-send" type="button" aria-label={t('conversation.sendSteer')} onClick={() => void submit('steer')}>{t('conversation.sendSteer')}</button><button className="composer-abort" type="button" aria-label={t('conversation.abort')} onClick={() => void kernel.commands.agent.abort(sessionId)}>{t('conversation.abortShort')}</button></div>
            : <button className="composer-send" type="submit" aria-label={t('conversation.send')} disabled={!value.trim() && pending.length === 0}>↑</button>}
        </div>
      </form>
    </div>
    {error ? <p className="composer-error" role="alert">{error}</p> : null}
  </footer>;
}
