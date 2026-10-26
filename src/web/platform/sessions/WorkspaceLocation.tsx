import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceView } from '../../../public/app-types.js';
import { Icon } from '../../components/icons';
import { copyText } from '../conversation/conversation-clipboard';
import { Button } from '../../components/ui/button';

type Props = {
  workspace: WorkspaceView | null; workspaces: WorkspaceView[];
  locationMode: 'new' | 'folder'; directory: string; parentDirectory: string; name: string;
  nativePicker: boolean; busy: boolean;
  onWorkspaceChange(workspace: WorkspaceView | null): void;
  onLocationModeChange(mode: 'new' | 'folder'): void;
  onDirectoryChange(value: string): void; onParentChange(value: string): void; onNameChange(value: string): void;
  onChooseDirectory(): void;
};

export function WorkspaceLocation(props: Props) {
  const { t } = useTranslation();
  const [editingName, setEditingName] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { workspace, directory, name, locationMode } = props;
  const recent = props.workspaces.filter(item => item.availability === 'ready' && item.kind !== 'standalone').sort((a, b) => {
    const activity = (item: WorkspaceView) => Math.max(Date.parse(item.createdAt || '') || 0, ...item.conversations.map(({ lastConversationAt }) => Date.parse(lastConversationAt || '') || 0));
    return activity(b) - activity(a);
  });
  const path = workspace?.path || (locationMode === 'folder' ? directory : props.parentDirectory);
  const parts = path.replaceAll('\\', '/').split('/');
  const displayPath = parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : path;
  return <section className="workspace-location" aria-label={t('workspaceFlow.workspace')}>
    {workspace || directory || locationMode === 'new' ? <>
      <div className="workspace-location-card">
        <Icon name="workspace" />
        <div className="workspace-location-info">
          {editingName && !workspace || locationMode === 'new' ? <label className="field-label"><span className="sr-only">{t('workspaceFlow.name')}</span><input value={name} maxLength={120} required autoFocus onChange={event => props.onNameChange(event.target.value)} onBlur={() => setEditingName(false)} placeholder={t('workspaceFlow.name')} /></label> : <strong>{workspace?.name || name}</strong>}
          <span className="workspace-location-path" title={path || t('workspaceFlow.defaultParent')}>{displayPath || t('workspaceFlow.defaultParent')}</span>
        </div>
        {!workspace && locationMode === 'folder' && <button className="icon-button" type="button" aria-label={t('workspaceFlow.editName')} onClick={() => setEditingName(true)}><Icon name="write" /></button>}
        <Button variant="quiet" type="button" onClick={() => { if (props.nativePicker) props.onChooseDirectory(); else { props.onWorkspaceChange(null); props.onDirectoryChange(''); props.onLocationModeChange('folder'); setEditingPath(true); } }}>{t('workspaceFlow.changeFolder')}</Button>
      </div>
      {path && <button className="workspace-path-copy" type="button" onClick={() => void copyText(path).then(() => setCopyFailed(false)).catch(() => setCopyFailed(true))}>{t(copyFailed ? 'workspaceFlow.copyFailed' : 'workspaceFlow.copyPath')}</button>}
    </> : <>
      {recent.length > 0 && <div className="workspace-recents"><span className="workspace-section-label">{t('workspaceFlow.recent')}</span><div className="workspace-recent-list">{recent.map(item => <button key={item.id} type="button" className="workspace-recent" onClick={() => props.onWorkspaceChange(item)}><Icon name="workspace" /><span><strong>{item.name}</strong><small title={item.path}>{item.path}</small></span><Icon name="chevron" /></button>)}</div></div>}
      <div className="workspace-location-actions"><Button type="button" variant="outline" disabled={props.busy} onClick={() => { if (props.nativePicker) props.onChooseDirectory(); else setEditingPath(true); }}><Icon name="workspace" />{t('workspaceFlow.openFolder')}</Button><Button type="button" variant="quiet" onClick={() => props.onLocationModeChange('new')}><Icon name="plus" />{t('workspaceFlow.createDirectory')}</Button></div>
    </>}
    {locationMode === 'folder' && editingPath && !workspace && <label className="field-label"><span>{t('workspaceFlow.directory')}</span><input aria-label={t('workspaceFlow.directory')} value={directory} placeholder={t('workspaceFlow.directoryPlaceholder')} onChange={event => props.onDirectoryChange(event.target.value)} autoFocus /><Button type="button" variant="quiet" disabled={!directory.trim()} onClick={() => setEditingPath(false)}>{t('workspaceFlow.useDirectory')}</Button></label>}
    {locationMode === 'new' && <details className="session-profile-details"><summary>{t('workspaceFlow.parent')}</summary><label className="field-label"><span className="sr-only">{t('workspaceFlow.parent')}</span><input value={props.parentDirectory} placeholder={t('workspaceFlow.defaultParent')} onChange={event => props.onParentChange(event.target.value)} /></label></details>}
  </section>;
}
