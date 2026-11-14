import type { ChildProcess } from 'node:child_process';
import type { CapabilityMismatchReason, ContractDiagnostic } from '../contracts/index.js';
import type { JsonRecord } from './types.js';
import type { SessionService } from './session-service.js';
import type { SessionPiLaunchInput } from './session-pi-launch.js';

type SpawnFn = (cmd: string, args: string[], opts: JsonRecord) => ChildProcess;

export type SessionManagerDependencies = {
  command: string;
  spawn: SpawnFn;
  endpoints: Record<SessionService, string>;
  runtimeClosed?(id: string): void;
  launch(input: SessionPiLaunchInput): { args: string[]; env: NodeJS.ProcessEnv } | Promise<{ args: string[]; env: NodeJS.ProcessEnv }>;
};

export type PiSessionManager = {
  runtime: SessionManagerDependencies;
  clock(): { hostGeneration: string; revision: number };
  broadcast(data: unknown): void;
  broadcastUpdated(id: string): void;
  cancelJobs(id: string): Promise<void>;
  removeExited(id: string, reason: string): void;
  isRegistered(id: string, session: object): boolean;
  delete(id: string, reason?: string): Promise<boolean>;
  broadcastCapabilityDiagnostic(id: string, mismatches: CapabilityMismatchReason[]): void;
  broadcastContractDiagnostic(id: string, diagnostics: ContractDiagnostic[]): void;
};
