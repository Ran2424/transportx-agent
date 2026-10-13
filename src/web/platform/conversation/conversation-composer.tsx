import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession, SessionAttachment } from '../../../public/app-types.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { Icon } from '../../components/icons';
import { isComposingInput } from '../../lib/input-composition';
import { AttachmentCards } from './conversation-attachments';
import { ComposerAttachmentList, useComposerAttachments } from './composer-attachments';
import { composerDraftStore } from './composer-draft-store';
import { SessionAttachmentLibrary } from './session-attachment-library';
import { ComposerContextUsage } from './composer-context-usage';
import { ComposerCitationPicker, useComposerCitationPicker } from './composer-citation-picker';
import { geoContextStore } from '../../features/geo/geo-context-store';
import { canvasContextStore } from '../canvas/canvas-context-store';

export function ConversationComposer({ retryDraft, sessionId, session, streaming, compacting, queued, attachments, attachmentError, onReloadAttachments, onCitationEnvelope, onOpenCitationManager }: { retryDraft?: { message: string }; sessionId: string; session: LiveSession | undefined; streaming: boolean; compacting: boolean; queued: Array<{ message: string; attachmentIds?: string[] }>; attachments: Record<string, SessionAttachment>; attachmentError?: string; onReloadAttachments(): void; onCitationEnvelope(citations: CitationEnvelope): void; onOpenCitationManager(): void; }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const value = useSyncExternalStore(composerDraftStore.subscribe, () => composerDraftStore.getMessage(sessionId));
  const setValue = (update: string | ((current: string) => string)) => composerDraftStore.setMessage(sessionId, typeof update === 'function' ? update(composerDraftStore.getMessage(sessionId)) : update);
  const [error, setError] = useState('');
  const { pending, setPending, addAttachments, removeAttachment, reuseAttachment } = useComposerAttachments(sessionId, setError);
  const geoContexts = useSyncExternalStore(geoContextStore.subscribe, () => geoContextStore.get(sessionId));
  const canvasContexts = useSyncExternalStore(canvasContextStore.subscribe, () => canvasContextStore.get(sessionId));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const uploading = pending.some((item) => item.status === 'uploading');
  const canSubmit = !compacting && !uploading && (!!value.trim() || pending.some((item) => item.status === 'ready' && item.attachment) || geoContexts.length > 0 || canvasContexts.length > 0);
  const { citeOpen, citeLoading, citeCandidates, setCiteOpen, openCitePicker, insertCitation } = useComposerCitationPicker({ sessionId, onCitationEnvelope, onInsert: (marker) => setValue((current) => current.replace('/cite', marker)), onError: setError, onFocus: () => inputRef.current?.focus() });
  useEffect(() => { if (retryDraft) { setValue(retryDraft.message); inputRef.current?.focus(); } }, [retryDraft]);
  const resize = () => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; } };
  useEffect(resize, [value]);
  async function submit(mode: 'prompt' | 'steer' = streaming ? 'steer' : 'prompt') {
    if (!canSubmit) return;
    const attachmentIds = pending.filter((item) => item.status === 'ready' && item.attachment).map((item) => item.attachment!.id);
    const geoContextIds = geoContexts.map((item) => item.contextId);
    const canvasContextIds = canvasContexts.map((item) => item.contextId);
    const message = value.trim() || (attachmentIds.length ? t('conversation.attachmentOnly') : geoContextIds.length ? t('conversation.geoContextOnly') : canvasContextIds.length ? t('conversation.canvasContextOnly') : '');
    if (!message) return;
    setError('');
    try { if (mode === 'steer') await kernel.commands.agent.steer({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds }); else await kernel.commands.agent.sendPrompt({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds }); if (composerDraftStore.getMessage(sessionId) === value) setValue(''); setPending((current) => current.filter((item) => !item.attachment || !attachmentIds.includes(item.attachment.id))); geoContextIds.forEach((id) => geoContextStore.remove(sessionId, id)); canvasContextIds.forEach((id) => canvasContextStore.remove(sessionId, id)); } catch (cause) { setError((cause as Error).message || t('conversation.sendFailed')); }
  }
  return <footer className="conversation-composer">
    <div className="queued-prompts">{queued.map((item, index) => <div key={`${item.message}-${index}`}><span>{t('conversation.queued')}</span><p>{item.message}</p><AttachmentCards sessionId={sessionId} attachmentIds={item.attachmentIds} attachments={attachments} compact /><button type="button" aria-label={t('conversation.cancelQueued')} onClick={() => kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId, index })}>×</button></div>)}</div>
    <SessionAttachmentLibrary sessionId={sessionId} attachments={attachments} selectedIds={pending.flatMap((item) => item.attachment ? [item.attachment.id] : [])} error={attachmentError} onReload={onReloadAttachments} onReuse={reuseAttachment} />
    <div className="composer-row">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {pending.length || geoContexts.length || canvasContexts.length ? <section className="composer-selection" aria-label={t('conversation.selectedContent')}>
          <header><strong>{t('conversation.selectedContent')}</strong><span>{t('common.itemCount', { count: pending.length + geoContexts.length + canvasContexts.length })}</span></header>
          <div className="composer-selection-list">
            <ComposerAttachmentList sessionId={sessionId} pending={pending} onRemove={(item) => void removeAttachment(item)} />
            {geoContexts.length ? <div className="composer-geo-contexts" aria-label={t('conversation.geoContexts')}>{geoContexts.map((item) => <div className="composer-context-card" key={item.contextId}><span className="pending-attachment-icon"><Icon name="map" /></span><span className="pending-attachment-copy"><strong title={item.summary}>{item.summary}</strong><small>{t('geo.map')} · {t(`geo.mode.${item.mode}`)} · {t('conversation.attachmentSelected')}</small></span><button className="composer-selection-remove" type="button" aria-label={t('conversation.removeGeoContext', { summary: item.summary })} onClick={() => geoContextStore.remove(sessionId, item.contextId)}>×</button></div>)}</div> : null}
            {canvasContexts.length ? <div className="composer-geo-contexts" aria-label={t('conversation.canvasContexts')}>{canvasContexts.map((item) => <div className="composer-context-card" key={item.contextId}><span className="pending-attachment-icon"><Icon name="file" /></span><span className="pending-attachment-copy"><strong title={item.displayTitle || item.viewId}>{item.displayTitle || item.viewId}</strong><small>{t('canvas.title')} · {t('conversation.contextRevision', { revision: item.revision })} · {t('conversation.attachmentSelected')}</small></span><button className="composer-selection-remove" type="button" aria-label={t('conversation.removeCanvasContext')} onClick={() => canvasContextStore.remove(sessionId, item.contextId)}>×</button></div>)}</div> : null}
          </div>
        </section> : null}
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
          onKeyDown={(event) => { if (isComposingInput(event.nativeEvent)) return; if (event.key === 'Escape' && citeOpen) { event.preventDefault(); setCiteOpen(false); return; } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          placeholder={streaming ? t('conversation.steerPlaceholder') : t('conversation.promptPlaceholder')}
          aria-label={t('conversation.messageInput')}
          disabled={compacting}
        />
        {citeOpen ? <ComposerCitationPicker loading={citeLoading} candidates={citeCandidates} onClose={() => setCiteOpen(false)} onSelect={(locatorId) => void insertCitation(locatorId)} /> : null}
        <div className="composer-toolbar">
          <div className="composer-action-rail">
            <button className="composer-attach" type="button" onClick={() => attachmentInputRef.current?.click()}>
              <Icon name="plus" />
              <span className="composer-action-hint" aria-hidden="true">{t('conversation.addAttachment')}</span>
              <span className="sr-only">{t('conversation.addAttachment')}</span>
            </button>
            <input ref={attachmentInputRef} className="composer-file-input" type="file" accept="*/*" multiple onChange={(event) => { if (event.currentTarget.files) void addAttachments(event.currentTarget.files, 'picker'); event.currentTarget.value = ''; }} />
            <button className="composer-tool-toggle" type="button" aria-label={t('conversation.openCitationManager')} onClick={onOpenCitationManager}><Icon name="citation" /><span className="composer-action-hint" aria-hidden="true">{t('conversation.citationManager')}</span></button>
            <ComposerContextUsage session={session} />
          </div>
          {compacting
            ? <span className="composer-compacting" role="status">{t('conversation.compacting')}</span>
            : streaming
            ? <div className="composer-stream-actions"><button className="composer-send" type="button" aria-label={t('conversation.sendSteer')} disabled={!canSubmit} onClick={() => void submit('steer')}>{t('conversation.sendSteer')}</button><button className="composer-abort" type="button" aria-label={t('conversation.abort')} onClick={() => void kernel.commands.agent.abort(sessionId).catch((cause) => setError((cause as Error).message || t('conversation.sendFailed')))}>{t('conversation.abortShort')}</button></div>
            : <button className="composer-send" type="submit" aria-label={t('conversation.send')} disabled={!canSubmit}>↑</button>}
        </div>
      </form>
    </div>
    {error ? <p className="composer-error" role="alert">{error}</p> : null}
  </footer>;
}
