import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatGPTSignIn } from '../../../contracts/chatgpt-plan.js';
import { appKernel } from '../../app/composition-root';
import { Button } from '../../components/ui/button';
import { DialogClose } from '../../components/ui/dialog';

const signIn = appKernel.commands.platform.chatGPTSignIn;

export function ChatGPTPlanSetup({ onConnected }: { onConnected(): void }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState<ChatGPTSignIn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const reportConnected = useEffectEvent(onConnected);
  const mounted = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current) void signIn('cancel', pending.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (attempt?.status !== 'waiting') return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function check(id: string) {
      try {
        const next = await signIn('status', id);
        if (!current) return;
        if (next.status === 'waiting') timer = setTimeout(() => void check(id), 1_000);
        else {
          pending.current = undefined;
          setAttempt(next);
          if (next.status === 'connected') reportConnected();
        }
      } catch (cause) {
        if (!current) return;
        void signIn('cancel', id).catch(() => {});
        pending.current = undefined;
        setAttempt(null);
        setError((cause as { message?: string })?.message || t('model.error.connect'));
      }
    }
    timer = setTimeout(() => void check(attempt.id), 1_000);
    return () => { current = false; clearTimeout(timer); };
  }, [attempt, t]);

  async function start(newAccount = false) {
    setStarting(true);
    setError('');
    try {
      const next = await signIn('start', undefined, newAccount);
      if (!mounted.current) {
        if (next.status === 'waiting') void signIn('cancel', next.id).catch(() => {});
        return;
      }
      setAttempt(next);
      if (next.status === 'waiting') {
        pending.current = next.id;
        if (next.authorizationUrl) window.open(next.authorizationUrl, '_blank', 'noopener,noreferrer');
      } else if (next.status === 'connected') onConnected();
    } catch (cause) {
      if (mounted.current) setError((cause as { message?: string })?.message || t('model.error.connect'));
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  const waiting = attempt?.status === 'waiting';
  return <div className="form-stack">
    <div className="provider-access-summary"><span><strong>ChatGPT</strong></span></div>
    <p className="field-help">{t('model.chatgpt.help')}</p>
    {waiting && <p className="field-help" role="status">{t('model.chatgpt.waiting')} {attempt.authorizationUrl && <a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('model.chatgpt.openBrowser')}</a>}</p>}
    {(error || attempt?.error) && <div className="inline-error" role="alert">{error || attempt?.error}</div>}
    <div className="form-actions">
      <DialogClose asChild><Button type="button" variant="quiet">{t('common.cancel')}</Button></DialogClose>
      <Button type="button" variant="quiet" disabled={waiting || starting} onClick={() => void start(true)}>{t('model.chatgpt.otherAccount')}</Button>
      <Button type="button" disabled={waiting || starting} onClick={() => void start()}>{t('model.chatgpt.continue')}</Button>
    </div>
  </div>;
}
