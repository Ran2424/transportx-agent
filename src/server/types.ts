/**
 * Server-only shared types. Protocol primitives are re-exported from
 * `src/contracts/common.ts`; everything else here is server-internal (command
 * frames, RPC plumbing, settings).
 */
import type { JsonRecord, ModelIdentity } from '../contracts/common.js';
export type { JsonRecord, ModelIdentity } from '../contracts/common.js';

export type ParsedModelSpec = { model: ModelIdentity | null; level: string | null };

export type TauArgs = Record<string, string | boolean | undefined> & {
  open?: boolean;
  desktop?: boolean;
  port?: string;
  host?: string;
  'parent-pid'?: string;
  'projects-dir'?: string;
};

export type TauSettingsFile = {
  tau?: {
    port?: string | number;
    host?: string;
    user?: string;
    pass?: string;
    authEnabled?: boolean;
    cookieSecret?: string;
    projectsDir?: string;
    enabledModuleIds?: string[];
    [key: string]: unknown;
  };
};

export type TauSettings = {
  port: number;
  host: string;
  user: string;
  pass: string;
  authEnabled?: boolean;
  cookieSecret?: string;
  projectsDir: string;
  enabledModuleIds: string[];
};

export type RpcCommand = {
  id?: string;
  type?: string;
  sessionId?: string;
  filePath?: string;
  outputPath?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  reasoning?: boolean;
  images?: boolean | Array<{ type: string; data: string; mimeType: string }>;
  attachmentIds?: string[];
  level?: string;
  name?: string;
  enabled?: boolean;
  sourcePath?: string;
  importId?: string;
  selections?: Array<{ id?: string; version?: string }>;
  kind?: string;
  moduleId?: string;
  [key: string]: unknown;
};

export type RpcResponse = JsonRecord;

export type PendingCommand = {
  resolve: (value: RpcResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  command?: string;
};

export type LiveClient = {
  readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  isAlive?: boolean;
};

export type StatusError = Error & { status?: number; stderr?: string };
