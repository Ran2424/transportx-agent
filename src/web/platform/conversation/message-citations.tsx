import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/icons';
import i18n from '../../i18n';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import { citationLocatorPosition, citationResourceUrl } from './citation-resource';
import type { MessageCitationProjection, ResolvedCitation } from '../../features/citation/citation-projection';

function citationPosition(item: ResolvedCitation) { return citationLocatorPosition(item.locator); }

const CITATION_CATEGORY_LABELS: Record<string, string> = {
  LEGAL_GOVERNANCE: 'conversation.category.legal',
  STANDARD_SPEC: 'conversation.category.standard',
  PLAN_PROCEDURE: 'conversation.category.plan',
  CASE_PRACTICE: 'conversation.category.case',
  METHOD_RESEARCH: 'conversation.category.research',
  PROJECT_DATA: 'conversation.category.project',
};

function citationCategory(item: ResolvedCitation) {
  if (item.resource.scope === 'artifact') return i18n.t('conversation.category.artifact');
  return i18n.t(CITATION_CATEGORY_LABELS[item.work.type] || 'conversation.category.reference');
}

type CitationPeek = { item: ResolvedCitation; anchor: DOMRect };

function CitationEvidencePeek({ peek, sessionId }: { peek: CitationPeek; sessionId: string }) {
  const { t } = useTranslation();
  const { item, anchor } = peek;
  const width = Math.min(720, window.innerWidth - 24);
  const height = item.resource.kind === 'pdf' || item.resource.kind === 'image' ? Math.min(680, window.innerHeight - 24) : 260;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + Math.min(22, anchor.width / 4)));
  const top = anchor.top > height + 24 ? anchor.top - height - 10 : Math.min(window.innerHeight - height - 12, anchor.bottom + 10);
  const visualUrl = item.resource.kind === 'pdf' && item.locator.page
    ? `${citationResourceUrl(sessionId, item.resource.resourceId, 'preview')}?page=${item.locator.page}`
    : item.resource.kind === 'image'
      ? citationResourceUrl(sessionId, item.resource.resourceId, 'preview')
      : '';
  return createPortal(
    <aside className="citation-evidence-peek" role="tooltip" style={{ width, height, left, top }}>
      <header><strong>{item.work.title}</strong><span>{citationPosition(item)}</span></header>
      {visualUrl
        ? <img src={visualUrl} alt={`${item.work.title}，${citationPosition(item)}`} />
        : <div className="citation-evidence-text"><span>{t('conversation.originalLocation')}</span><p>{item.locator.quote || t('conversation.noQuote')}</p></div>}
    </aside>,
    document.body,
  );
}

export function MessageArtifacts({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const openDocument = useOpenDocument();
  function openResource(item: ResolvedCitation) {
    if (documentFormat(item.resource.relativePath, item.resource.mimeType)) openDocument({ sessionId, title: item.work.title, path: item.resource.relativePath, resource: item.resource, locator: item.resource.scope === 'artifact' ? undefined : item.locator });
    else setPreview(item);
  }
  if (!projection?.artifacts.length) return null;
  return <section className="message-artifacts">
    <header><strong>{t('conversation.artifacts')}</strong><span>{t('common.itemCount', { count: projection.artifacts.length })}</span></header>
    <div>{projection.artifacts.map((item) => {
      const name = item.resource.relativePath.replaceAll('\\', '/').split('/').pop() || item.work.title;
      const presentation = filePresentation({ name, path: item.resource.relativePath, isDirectory: false });
      return <button key={item.occurrence.occurrenceId} type="button" onClick={() => openResource(item)}>
        <span className="message-artifact-icon"><Icon name={presentation.icon} /></span>
        <span><strong>{item.work.title}</strong><small>{presentation.label}</small></span>
        <Icon name="chevron" />
      </button>;
    })}</div>
    {preview ? <FilePreview
      item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}

export function CitationFooter({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const openDocument = useOpenDocument();
  function openResource(item: ResolvedCitation) {
    if (documentFormat(item.resource.relativePath, item.resource.mimeType)) openDocument({ sessionId, title: item.work.title, path: item.resource.relativePath, resource: item.resource, locator: item.resource.scope === 'artifact' ? undefined : item.locator });
    else setPreview(item);
  }
  const [peek, setPeek] = useState<CitationPeek | null>(null);
  if (!projection || (!projection.citations.length && !projection.unavailableIds.length)) return null;
  const groups = [...projection.citations.reduce((map, item) => {
    map.set(item.resource.resourceId, [...(map.get(item.resource.resourceId) || []), item]);
    return map;
  }, new Map<string, ResolvedCitation[]>()).values()];
  return <section className="citation-footer"><header><strong>{t('conversation.citations')}</strong><span>{t('common.referenceCount', { count: projection.citations.length })}</span></header><ol>{groups.map((items) => {
    const first = items[0];
    return <li key={first.resource.resourceId}>
      <header className="citation-source-heading">
        <div><strong>{citationCategory(first)}</strong><button type="button" onClick={() => openResource(first)} title={t('conversation.viewSource')}><Icon name="file" />{first.work.title}</button></div>
        <span>{t('common.referenceCount', { count: items.length })}</span>
      </header>
      <div className="citation-locator-list">{items.map((item) => <button
        className="citation-locator"
        type="button"
        key={item.occurrence.occurrenceId}
        data-citation-card={item.occurrence.occurrenceId}
        onClick={() => { setPeek(null); openResource(item); }}
        onMouseEnter={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => setPeek(null)}
        onFocus={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onBlur={() => setPeek(null)}
      >
        <span className="citation-number">{item.number}</span>
        <span className="citation-locator-copy"><strong>{citationPosition(item)}</strong>{item.locator.quote ? <span>{item.locator.quote}</span> : null}</span>
        <span className="citation-locator-hint">{t('conversation.hover')}</span>
      </button>)}</div>
    </li>;
  })}</ol>
    {projection.unavailableIds.length ? <p className="citation-warning">{t('conversation.unavailable', { ids: projection.unavailableIds.join(', ') })}</p> : null}
    {peek ? <CitationEvidencePeek peek={peek} sessionId={sessionId} /> : null}
    {preview ? <FilePreview
      item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      externalSource={{
        url: citationResourceUrl(sessionId, preview.resource.resourceId),
        kind: preview.resource.kind === 'image' ? 'image' : 'document',
        mimeType: preview.resource.mimeType,
      }}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}
