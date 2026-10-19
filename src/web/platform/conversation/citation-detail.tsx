import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CITATION_CONTENT_LABELS, type CitationDetail } from '../../../contracts/citation';
import { citationLocatorText } from '../../../contracts/citation-compiler';
import { citationCanvasTarget } from '../../../contracts/canvas-document';
import { appKernel } from '../../app/composition-root';
import { Dialog } from '../../components/ui/dialog';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';
import { citationResourceUrl } from './citation-resource';
import { CitationCurrentFile } from './CitationCurrentFile';
export const citationContentLabels = CITATION_CONTENT_LABELS;
type Selection = { sessionId: string; ids: string[] };
const CitationDetailContext = createContext<(sessionId: string, ids: string[]) => void>(() => {});
export function useCitationDetail() { return useContext(CitationDetailContext); }
export function CitationDetailProvider({ sessionId, children }: { sessionId: string | null | undefined; children: ReactNode }) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [details, setDetails] = useState<CitationDetail[]>([]), [errors, setErrors] = useState<string[]>([]), [loading, setLoading] = useState(false);
  const openDocument = useOpenDocument();
  const trigger = useRef<{ node: HTMLElement; scope: HTMLElement | null; id?: string } | null>(null);
  useEffect(() => { setSelection(null); }, [sessionId]);
  useEffect(() => {
    setDetails([]); setErrors([]);
    if (!selection || selection.sessionId !== sessionId) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled(selection.ids.map((id) => appKernel.commands.citation.detail(selection.sessionId, id, controller.signal))).then((results) => {
      if (!active) return;
      setDetails(results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []));
      setErrors(results.flatMap((result, index) => result.status === 'rejected' ? [`${selection.ids[index]}：${result.reason instanceof Error ? result.reason.message : '依据不可用'}`] : []));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [selection, sessionId]);
  function openSource(detail: CitationDetail) {
    const { source, evidence } = detail;
    if (source.content.kind !== 'file') return;
    const target = citationCanvasTarget(evidence.locator);
    openDocument({ sessionId: selection!.sessionId, title: source.title, path: source.content.path, source, locator: evidence.locator, ...(target ? { canvasTarget: target } : {}) });
    setSelection(null);
  }
  const showDetail = useCallback((id: string, ids: string[]) => {
    const node = document.activeElement;
    trigger.current = node instanceof HTMLElement ? { node, scope: node.closest<HTMLElement>('.conversation-message'), id: node.dataset.citationId || node.dataset.citationCard } : null;
    setSelection({ sessionId: id, ids: [...new Set(ids)] });
  }, []);
  return <CitationDetailContext.Provider value={showDetail}>
    {children}
    <Dialog open={!!selection && selection.sessionId === sessionId} onOpenChange={(open) => { if (!open) setSelection(null); }} title="引用依据" className="citation-detail" onCloseAutoFocus={(event) => {
      event.preventDefault();
      const previous = trigger.current;
      if (!previous) return;
      const node = previous.node.isConnected ? previous.node : [...(previous.scope?.querySelectorAll<HTMLElement>('[data-citation-id], [data-citation-card]') || [])].find((item) => (item.dataset.citationId || item.dataset.citationCard) === previous.id);
      node?.focus({ preventScroll: true });
    }}>
      {loading ? <p role="status">正在读取固定版本…</p> : null}
      {errors.map((error) => <p className="citation-warning" role="alert" key={error}>{error}</p>)}
      {(selection && selection.sessionId === sessionId ? details : []).map((detail) => {
        const { source, evidence, preview } = detail, file = source.content.kind === 'file' ? source.content : undefined;
        const resourceError = preview.kind === 'none' ? preview.code : undefined;
        return <section key={evidence.evidenceId} className="citation-detail-item">
          <header><h3>{source.title}</h3><span>{citationContentLabels[evidence.contentKind]} · {citationLocatorText(evidence.locator)}</span></header>
          {evidence.text ? <blockquote>{evidence.text}</blockquote> : null}
          {evidence.contentKind === 'summary' ? <p className="citation-detail-note">以上为知识归纳；请结合下方原件核对。</p> : null}
          {preview.kind === 'table' ? <div className="citation-table-scroll"><table><thead><tr><th scope="col">行</th>{preview.table.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{preview.table.rows.map((row, index) => <tr key={index} className={evidence.locator.kind === 'table' && index + (preview.rowStart || 1) >= (evidence.locator.rowStart || 1) && index + (preview.rowStart || 1) <= (evidence.locator.rowEnd || evidence.locator.rowStart || 0) ? 'is-cited' : ''}><th scope="row">{index + (preview.rowStart || 1)}</th>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell === null ? '—' : String(cell)}</td>)}</tr>)}</tbody></table></div> : preview.kind === 'text' ? <pre className="citation-detail-text">{preview.text}</pre> : <p role={resourceError ? 'alert' : undefined}>{resourceError ? t(`citation.error.${resourceError}`) : preview.reason}</p>}
          {preview.kind !== 'none' && preview.truncated ? <p className="citation-detail-note">当前显示定位附近最多 200 行；完整内容请查看原件。</p> : null}
          <div className="citation-detail-actions">{!resourceError && file && documentFormat(file.path, file.mimeType) ? <button type="button" onClick={() => openSource(detail)}>在 Canvas 查看{citationCanvasTarget(evidence.locator) ? '定位' : '原件'}</button> : null}{!resourceError && file ? <a href={`${citationResourceUrl(selection!.sessionId, source.sourceVersionId)}?sha256=${file.sha256}&download=1`} download>下载原件</a> : null}{resourceError === 'content-changed' ? <CitationCurrentFile sessionId={selection!.sessionId} source={source} onOpened={() => setSelection(null)} /> : null}</div>
          {resourceError && preview.kind === 'none' ? <details><summary>错误诊断 · {resourceError}</summary><p>{preview.reason}</p></details> : null}
          <details><summary>来源与版本信息</summary><dl><dt>固定版本</dt><dd>{source.content.sha256}</dd>{file ? <><dt>受控位置</dt><dd>{file.assetId ? `${file.assetId} / ` : ''}{file.path}</dd></> : null}{Object.entries(source.metadata || {}).map(([key, value]) => <div key={key}><dt>{{ bibliographicType: '文献类型', author: '作者', issuer: '发布机构', issuedAt: '发布日期', standardNumber: '标准编号', edition: '版次', url: '来源网址', version: '来源版本', timeRange: '时间范围', querySummary: '查询说明' }[key] || key}</dt><dd>{Array.isArray(value) ? value.join('、') : value}</dd></div>)}<dt>取得时间</dt><dd>{source.acquiredAt}</dd><dt>执行记录</dt><dd>{source.executionRef ? `${source.executionRef.operation} · ${source.executionRef.path}` : '未提供受控执行记录'}</dd></dl></details>
        </section>;
      })}
    </Dialog>
  </CitationDetailContext.Provider>;
}
