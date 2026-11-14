import { conversationView, type LiveSession, type ConversationView, type WorkspaceIndex, type SessionAttachment, type SessionAttachmentSource, type SessionSnapshot } from '../app-types.js';
import type { CreateConversationInput, ConversationRecordV1, WorkspaceManifestV1 } from '../../contracts/workspace.js';
import { appError, type AppErrorCategory } from '../../contracts/errors.ts';
import { httpJson, type CommandDeps } from './command-transport.js';
import type { SessionProfileV1 } from '../../contracts/session-profile.ts';

export type RenameSessionInput = { conversationId: string; name: string; expectedRevision: number };
export type DeletionRequest = { requestId: string; expectedRevision: number; confirm: true; stopCurrent?: boolean };
export type WorkspaceFile = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number | null;
  mtime?: number;
};

export type WorkspaceFileContent = { content: string; size: number; encoding?: 'utf8' | 'base64'; stale?: boolean };

export type UploadAttachmentInput = { sessionId: string; file: File; source: SessionAttachmentSource };

export type SessionCommands = {
  list(): Promise<WorkspaceIndex>;
  searchHistory(query: string): Promise<Array<{ workspaceId: string; conversationId: string; name: string; matches: Array<{ snippet?: string }> }>>;
  create(input: CreateConversationInput): Promise<ConversationView>;
  activate(conversationId: string, input?: { stopCurrent?: boolean; confirmCurrentConfiguration?: { expectedRevision: number; domainId: string; modelSpec: string; profile: SessionProfileV1 } }): Promise<ConversationView>;
  rename(input: RenameSessionInput): Promise<void>;
  moveConversation(conversationId: string, input: { target: 'standalone' | string; stopCurrent?: boolean }): Promise<ConversationView>;
  loadSnapshot(conversationId: string): Promise<SessionSnapshot>;
  listFiles(conversationId: string, path?: string, signal?: AbortSignal): Promise<{ path: string; items: WorkspaceFile[] }>;
  openInSystem(conversationId: string, path: string): Promise<void>;
  readFileContent(conversationId: string, path: string): Promise<WorkspaceFileContent>;
  listAttachments(conversationId: string): Promise<SessionAttachment[]>;
  uploadAttachment(input: UploadAttachmentInput): Promise<SessionAttachment>;
  deleteAttachment(conversationId: string, attachmentId: string): Promise<void>;
  close(conversationId: string, stopCurrent?: boolean): Promise<void>;
  deleteConversation(conversationId: string, input: DeletionRequest): Promise<void>;
  updateWorkspace(workspaceId: string, input: Record<string, unknown>): Promise<void>;
  deleteWorkspace(workspaceId: string, input: DeletionRequest): Promise<void>;
  setWorkspaceSidebarVisibility(workspaceId: string, hidden: boolean): Promise<void>;
  releaseMissingWorkspace(workspaceId: string): Promise<void>;
  deleteIsolatedWorkspace(workspaceId: string, input: DeletionRequest): Promise<void>;
  migration(path?: string, input?: Record<string, unknown>): Promise<unknown>;
};

export function createSessionCommands(deps: CommandDeps): SessionCommands {
  const context = { category: 'session' as AppErrorCategory };
  const attachmentGenerations = new Map<string, number>();
  const advanceAttachments = (sessionId: string) => {
    const generation = (attachmentGenerations.get(sessionId) || 0) + 1;
    attachmentGenerations.set(sessionId, generation);
    return generation;
  };
  const commands: SessionCommands = {
    async list() {
      const index = await httpJson(deps.http, '/api/workspaces', undefined, context) as WorkspaceIndex;
      deps.dispatch({ type: 'session/indexReceived', index });
      return index;
    },
    async searchHistory(query) {
      if (query.trim().length < 2) return [];
      const data = await httpJson(deps.http, `/api/conversations/search?q=${encodeURIComponent(query.trim())}`, undefined, context);
      return (data as { results: Array<{ workspaceId: string; conversationId: string; name: string; matches: Array<{ snippet?: string }> }> }).results;
    },
    async create(input) {
      const result = await httpJson(deps.http, '/api/conversations', { method: 'POST', body: input }, context) as { directory: string; manifest: WorkspaceManifestV1; conversation: ConversationRecordV1 };
      return conversationView(result.conversation, { ...result.manifest, path: result.directory }, null);
    },
    async activate(id, input = {}) {
      const result = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}/activate`, { method: 'POST', body: input }, { ...context, sessionId: id }) as { runtime: LiveSession };
      deps.dispatch({ type: 'session/runtimeReceived', runtime: result.runtime });
      const snapshot = await commands.loadSnapshot(id);
      deps.dispatch({ type: 'session/snapshotReceived', sessionId: id, snapshot });
      return snapshot.session!;
    },
    async rename({ conversationId, ...input }) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'PATCH', body: input }, { ...context, sessionId: conversationId });
      deps.dispatch({ type: 'session/updated', session: { id: conversationId, sessionName: input.name } });
    },
    async moveConversation(conversationId, input) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(conversationId)}/move`, { method: 'POST', body: input }, { ...context, sessionId: conversationId }) as { workspace: { id: string; path: string; revision: number }; conversation: ConversationRecordV1; runtime: LiveSession | null };
      const liveSessionId = deps.liveSessionId(conversationId);
      if (liveSessionId) deps.dispatch({ type: 'session/runtimeClosed', liveSessionId });
      const view = conversationView(data.conversation, data.workspace, data.runtime);
      deps.dispatch({ type: 'session/updated', session: view });
      return view;
    },
    async loadSnapshot(id) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}/snapshot`, undefined, { ...context, sessionId: id }) as { workspace: { id: string; path: string; revision: number }; conversation: ConversationRecordV1; runtime: LiveSession | null; snapshot: SessionSnapshot; resourceLinks: Record<string, string>; hostGeneration: string; revision: number };
      return { ...data.snapshot, hostGeneration: data.hostGeneration, revision: data.revision, sessionId: id, session: { ...conversationView(data.conversation, data.workspace, data.runtime), resourceLinks: data.resourceLinks } };
    },
    async listFiles(sessionId, path, signal) {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/files?${params}`, { signal }, { ...context, sessionId });
      return data as { path: string; items: WorkspaceFile[] };
    },

    async readFileContent(sessionId, path) {
      const params = new URLSearchParams({ path });
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/files/content?${params}`, undefined, { ...context, sessionId });
      return data as WorkspaceFileContent;
    },

    async openInSystem(sessionId, path) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/open`, { method: 'POST', body: { path } }, { ...context, sessionId });
    },

    async listAttachments(sessionId) {
      const generation = advanceAttachments(sessionId);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments`, undefined, { ...context, sessionId });
      const attachments = (data as { attachments?: SessionAttachment[] }).attachments ?? [];
      if (attachmentGenerations.get(sessionId) === generation) deps.dispatch({ type: 'session/attachmentsReceived', sessionId, attachments });
      return attachments;
    },

    async uploadAttachment({ sessionId, file, source }) {
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments?source=${encodeURIComponent(source)}`, { method: 'POST', body: form }, { ...context, sessionId });
      const attachment = (data as { attachments?: SessionAttachment[] }).attachments?.[0];
      if (!attachment) throw appError({ code: 'attachment_upload_invalid_response', category: 'transport', message: '附件上传响应无效', sessionId, retryable: false });
      advanceAttachments(sessionId);
      deps.dispatch({ type: 'session/attachmentAdded', sessionId, attachment });
      return attachment;
    },

    async deleteAttachment(sessionId, attachmentId) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, { ...context, sessionId });
      advanceAttachments(sessionId);
      deps.dispatch({ type: 'session/attachmentRemoved', sessionId, attachmentId });
    },

    async close(sessionId, stopCurrent = false) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: { stopCurrent } }, { ...context, sessionId });
      const liveSessionId = deps.liveSessionId(sessionId); if (liveSessionId) deps.dispatch({ type: 'session/runtimeClosed', liveSessionId });
    },
    async deleteConversation(id, input) { await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', body: input }, context); },
    async updateWorkspace(id, input) { await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }, context); },
    async deleteWorkspace(id, input) { await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}/delete`, { method: 'POST', body: input }, context); },
    async setWorkspaceSidebarVisibility(id, hidden) {
      await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}/sidebar`, { method: 'PATCH', body: { hidden } }, context);
      await commands.list();
    },
    async releaseMissingWorkspace(id) {
      await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}/release`, { method: 'POST', body: {} }, context);
      await commands.list();
    },
    async deleteIsolatedWorkspace(id, input) { await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}/migration/delete`, { method: 'POST', body: input }, context); },
    async migration(path = '/api/migration', input) { return httpJson(deps.http, path, input ? { method: 'POST', body: input } : undefined, context); },
  };
  return commands;
}
