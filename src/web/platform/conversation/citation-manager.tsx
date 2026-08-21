import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { exportCitationBibliography } from '../../../contracts/citation-compiler.ts';
import type { CitationEnvelope, CitationLocator, CitationResource, CitationWork } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { Icon } from '../../components/icons';
import { FilePreview } from '../workspace/FilePreview';
import { artifactPreviewKind, citationLocatorPosition, citationResourceUrl } from './citation-resource';
import type { ResolvedCitation } from '../../features/citation/citation-projection';

function downloadCitationExport(envelope: CitationEnvelope, format: 'bibtex' | 'csl-json' | 'ris') {
  const extensions = { bibtex: 'bib', 'csl-json': 'json', ris: 'ris' } as const;
  const mimeTypes = { bibtex: 'application/x-bibtex', 'csl-json': 'application/json', ris: 'application/x-research-info-systems' } as const;
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([exportCitationBibliography(envelope, format)], { type: mimeTypes[format] }));
  anchor.download = `citations.${extensions[format]}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

export function CitationManager({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [envelope, setEnvelope] = useState<CitationEnvelope | null>(null);
  const [scope, setScope] = useState<'all' | CitationResource['scope']>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const [selectedLocators, setSelectedLocators] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void kernel.commands.citation.list(sessionId).then((citations) => {
      if (active) setEnvelope(citations);
    }).catch((cause) => { if (active) setError((cause as Error).message || t('conversation.citationUnavailable')); });
    return () => { active = false; };
  }, [kernel, sessionId, t]);
  const rows = useMemo(() => {
    if (!envelope) return [];
    const works = new Map(envelope.works.map((work) => [work.workId, work]));
    const locators = new Map<string, CitationLocator[]>();
    for (const locator of envelope.locators) locators.set(locator.resourceId, [...(locators.get(locator.resourceId) || []), locator]);
    const uses = new Map<string, number>();
    for (const occurrence of envelope.occurrences) {
      const locator = envelope.locators.find((item) => item.locatorId === occurrence.locatorId);
      if (locator) uses.set(locator.resourceId, (uses.get(locator.resourceId) || 0) + 1);
    }
    const normalized = query.trim().toLowerCase();
    return envelope.resources.flatMap((resource) => {
      const work = works.get(resource.workId);
      if (!work || (scope !== 'all' && resource.scope !== scope) || (normalized && !`${work.title} ${work.citekey || ''} ${resource.scope}`.toLowerCase().includes(normalized))) return [];
      return [{ resource, work, locators: locators.get(resource.resourceId) || [], uses: uses.get(resource.resourceId) || 0 }];
    });
  }, [envelope, query, scope]);
  const previewCitation = (resource: CitationResource, work: CitationWork, locator?: CitationLocator) => {
    if (!locator) return;
    setPreview({ occurrence: { occurrenceId: `manager:${locator.locatorId}`, locatorId: locator.locatorId, containerType: 'document', containerId: 'citation-manager' }, resource, work, locator, number: 0 });
  };
  return createPortal(<div className="citation-manager-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="citation-manager" role="dialog" aria-modal="true" aria-label={t('conversation.citationManager')} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><strong>{t('conversation.citationManager')}</strong><span>{envelope ? t('common.resourceCount', { resources: envelope.resources.length, uses: envelope.occurrences.length }) : t('conversation.loadingEvidenceGraph')}</span></div><button type="button" aria-label={t('conversation.closeCitationManager')} onClick={onClose}><Icon name="close" /></button></header>
      <div className="citation-manager-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('conversation.filterCitation')} aria-label={t('conversation.filterCitationLabel')} /><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} aria-label={t('conversation.citationScope')}><option value="all">{t('conversation.scope.all')}</option><option value="knowledge">{t('conversation.scope.knowledge')}</option><option value="attachment">{t('conversation.scope.attachment')}</option><option value="artifact">{t('conversation.scope.artifact')}</option><option value="web">{t('conversation.scope.web')}</option><option value="dataset">{t('conversation.scope.dataset')}</option></select><div>{(['bibtex', 'csl-json', 'ris'] as const).map((format) => <button key={format} type="button" disabled={!envelope} onClick={() => envelope && downloadCitationExport(envelope, format)}>{format === 'csl-json' ? 'CSL-JSON' : format.toUpperCase()}</button>)}</div></div>
      <div className="citation-manager-body">{error ? <p className="citation-manager-status is-error">{error}</p> : !envelope ? <p className="citation-manager-status">{t('conversation.loadingEvidence')}</p> : rows.length ? rows.map(({ resource, work, locators, uses }) => {
        const locator = locators.find((item) => item.locatorId === selectedLocators[resource.resourceId]) || locators[0];
        return <article key={resource.resourceId}><div><span className="citation-manager-scope">{resource.scope}</span><strong>{work.title}</strong><small>{work.citekey || resource.resourceId} · {t('common.locationCount', { uses, locations: locators.length })}</small></div><div className="citation-manager-locator"><select value={locator?.locatorId || ''} disabled={!locators.length} aria-label={t('conversation.sourceLocation')} onChange={(event) => setSelectedLocators((current) => ({ ...current, [resource.resourceId]: event.target.value }))}>{locators.map((item) => <option key={item.locatorId} value={item.locatorId}>{citationLocatorPosition(item)}</option>)}</select><button type="button" disabled={!locator} onClick={() => previewCitation(resource, work, locator)}>{t('conversation.viewEvidence')}</button></div>{envelope.provenance.filter((edge) => edge.fromResourceId === resource.resourceId || edge.toResourceId === resource.resourceId).length ? <p>{t('conversation.provenance', { relations: envelope.provenance.filter((edge) => edge.fromResourceId === resource.resourceId || edge.toResourceId === resource.resourceId).map((edge) => edge.relation).join(', ') })}</p> : null}</article>;
      }) : <p className="citation-manager-status">{t('conversation.noCitations')}</p>}</div>
    </section>
    {preview ? <FilePreview item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }} sessionId={sessionId} stackIndex={0} initialOffset={0} externalSource={{ url: citationResourceUrl(sessionId, preview.resource.resourceId), kind: artifactPreviewKind(preview.resource), mimeType: preview.resource.mimeType, page: preview.locator.page }} onActivate={() => {}} onClose={() => setPreview(null)} /> : null}
  </div>, document.body);
}
