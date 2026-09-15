import { asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseSessionProfileStructured, type SessionProfileV1 } from './session-profile.ts';

export const RESOLVED_SESSION_PLAN_SCHEMA_VERSION = 3 as const;
export type ResolvedPlanEntrypoint = { kind: 'prompt' | 'skill' | 'extension'; path: string; sha256: string };
export type ResolvedPlanNativeRuntime = {
  id: string;
  kind: 'ffmpeg';
  platform: 'darwin' | 'win32';
  arch: 'arm64' | 'x64';
  version: string;
  ffmpeg: { path: string; sha256: string };
  ffprobe: { path: string; sha256: string };
};
export type ResolvedPlanModule = {
  id: string;
  version: string;
  type: 'module' | 'capability' | 'domain';
  origin: 'builtin' | 'installed' | 'external';
  packageRoot: string;
  manifestSha256: string;
  entrypoints: ResolvedPlanEntrypoint[];
  nativeRuntimes: ResolvedPlanNativeRuntime[];
};
export type ResolvedPlanAsset = {
  id: string;
  kind: 'knowledge' | 'data' | 'template';
  moduleId: string;
  moduleVersion: string;
  path: string;
  integrityFile?: string;
  integrityFileSha256?: string;
  integrityStatus: 'verified' | 'unverified';
};
export type ResolvedSessionPlanV3 = {
  schemaVersion: 3;
  platform: { name: 'TransportX Agent'; version: string };
  profile: SessionProfileV1;
  domain: { id: string; version: string };
  modules: ResolvedPlanModule[];
  assets: ResolvedPlanAsset[];
  runtime: { piVersion?: string; pythonVersion?: string };
  workspace: string;
  createdAt: string;
};
export type ResolvedSessionPlanParseResult =
  | { ok: true; value: ResolvedSessionPlanV3; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const SHA256_RE = /^[a-f0-9]{64}$/;
const PLATFORM_NAMES = ['TransportX Agent', 'TransportX Traffic Agent'];

export function parseResolvedSessionPlanStructured(value: unknown): ResolvedSessionPlanParseResult {
  const root = asRecord(value);
  const diagnostics: ContractDiagnostic[] = [];
  if (!root) return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'plan', message: 'Resolved session plan must be an object.' })] };
  if (root.schemaVersion !== 3) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'plan.schemaVersion', message: 'Unsupported resolved session plan schemaVersion.', expected: 3, received: typeof root.schemaVersion === 'string' || typeof root.schemaVersion === 'number' ? root.schemaVersion : String(root.schemaVersion) }));
  const profile = parseSessionProfileStructured(root.profile);
  if (!profile.ok) diagnostics.push(...profile.diagnostics);
  const platform = asRecord(root.platform);
  const domain = asRecord(root.domain);
  const runtime = asRecord(root.runtime);
  const workspace = asString(root.workspace, 2000);
  const createdAt = asString(root.createdAt, 80);
  if (!PLATFORM_NAMES.includes(String(platform?.name)) || !asString(platform?.version, 100)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'plan.platform', message: 'Invalid platform identity.' }));
  if (!asString(domain?.id, 200) || !asString(domain?.version, 100)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'plan.domain', message: 'Invalid domain identity.' }));
  if (!runtime || !workspace || !createdAt) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'plan', message: 'runtime, workspace and createdAt are required.' }));
  const modules: ResolvedPlanModule[] = [];
  const moduleIds = new Set<string>();
  if (!Array.isArray(root.modules)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'plan.modules', message: 'modules must be an array.' }));
  else root.modules.forEach((candidate, index) => {
    const item = asRecord(candidate);
    const id = asString(item?.id, 200); const version = asString(item?.version, 100); const packageRoot = asString(item?.packageRoot, 2000); const manifestSha256 = asString(item?.manifestSha256, 64);
    const type = item?.type; const origin = item?.origin;
    const entrypoints: ResolvedPlanEntrypoint[] = [];
    if (Array.isArray(item?.entrypoints)) item.entrypoints.forEach((entry) => {
      const parsed = asRecord(entry); const kind = parsed?.kind; const entryPath = asString(parsed?.path, 2000); const sha256 = asString(parsed?.sha256, 64);
      if ((kind === 'prompt' || kind === 'skill' || kind === 'extension') && entryPath && sha256 && SHA256_RE.test(sha256)) entrypoints.push({ kind, path: entryPath, sha256 });
    });
    const nativeRuntimes: ResolvedPlanNativeRuntime[] = [];
    const rawRuntimes = item?.nativeRuntimes === undefined ? [] : item.nativeRuntimes;
    if (Array.isArray(rawRuntimes)) rawRuntimes.forEach((candidateRuntime) => {
      const runtime = asRecord(candidateRuntime);
      const ffmpeg = asRecord(runtime?.ffmpeg); const ffprobe = asRecord(runtime?.ffprobe);
      const runtimeId = asString(runtime?.id, 200); const runtimeVersion = asString(runtime?.version, 100);
      const ffmpegPath = asString(ffmpeg?.path, 2000); const ffmpegSha256 = asString(ffmpeg?.sha256, 64);
      const ffprobePath = asString(ffprobe?.path, 2000); const ffprobeSha256 = asString(ffprobe?.sha256, 64);
      if (runtimeId && runtime?.kind === 'ffmpeg' && ['darwin', 'win32'].includes(String(runtime.platform)) && ['arm64', 'x64'].includes(String(runtime.arch)) && runtimeVersion && ffmpegPath && ffmpegSha256 && SHA256_RE.test(ffmpegSha256) && ffprobePath && ffprobeSha256 && SHA256_RE.test(ffprobeSha256)) {
        nativeRuntimes.push({ id: runtimeId, kind: 'ffmpeg', platform: runtime.platform as ResolvedPlanNativeRuntime['platform'], arch: runtime.arch as ResolvedPlanNativeRuntime['arch'], version: runtimeVersion, ffmpeg: { path: ffmpegPath, sha256: ffmpegSha256 }, ffprobe: { path: ffprobePath, sha256: ffprobeSha256 } });
      }
    });
    if (!id || !version || !packageRoot || !manifestSha256 || !SHA256_RE.test(manifestSha256) || moduleIds.has(id) || !['module', 'capability', 'domain'].includes(String(type)) || !['builtin', 'installed', 'external'].includes(String(origin)) || !Array.isArray(item?.entrypoints) || entrypoints.length !== item.entrypoints.length || !Array.isArray(rawRuntimes) || nativeRuntimes.length !== rawRuntimes.length) diagnostics.push(diagnostic({ code: 'invalid_type', path: `plan.modules[${index}]`, message: 'Invalid or duplicate resolved Module.' }));
    else { moduleIds.add(id); modules.push({ id, version, packageRoot, manifestSha256, type: type as ResolvedPlanModule['type'], origin: origin as ResolvedPlanModule['origin'], entrypoints, nativeRuntimes }); }
  });
  const assets: ResolvedPlanAsset[] = [];
  const assetIds = new Set<string>();
  if (!Array.isArray(root.assets)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'plan.assets', message: 'assets must be an array.' }));
  else root.assets.forEach((candidate, index) => {
    const item = asRecord(candidate); const id = asString(item?.id, 200); const moduleId = asString(item?.moduleId, 200); const moduleVersion = asString(item?.moduleVersion, 100); const assetPath = asString(item?.path, 2000); const kind = item?.kind; const integrityStatus = item?.integrityStatus;
    const integrityFile = asString(item?.integrityFile, 2000) ?? undefined; const integrityFileSha256 = asString(item?.integrityFileSha256, 64) ?? undefined;
    if (!id || !moduleId || !moduleVersion || !assetPath || assetIds.has(id) || !['knowledge', 'data', 'template'].includes(String(kind)) || !['verified', 'unverified'].includes(String(integrityStatus)) || (integrityFileSha256 && !SHA256_RE.test(integrityFileSha256))) diagnostics.push(diagnostic({ code: 'invalid_type', path: `plan.assets[${index}]`, message: 'Invalid or duplicate resolved asset.' }));
    else { assetIds.add(id); assets.push({ id, moduleId, moduleVersion, path: assetPath, kind: kind as ResolvedPlanAsset['kind'], integrityStatus: integrityStatus as ResolvedPlanAsset['integrityStatus'], ...(integrityFile ? { integrityFile } : {}), ...(integrityFileSha256 ? { integrityFileSha256 } : {}) }); }
  });
  if (diagnostics.length || !profile.ok || !platform || !domain || !runtime || !workspace || !createdAt) return { ok: false, value: null, diagnostics };
  return { ok: true, diagnostics: [], value: { schemaVersion: 3, platform: { name: 'TransportX Agent', version: asString(platform.version, 100)! }, profile: profile.value, domain: { id: asString(domain.id, 200)!, version: asString(domain.version, 100)! }, modules, assets, runtime: { ...(asString(runtime.piVersion, 100) ? { piVersion: asString(runtime.piVersion, 100)! } : {}), ...(asString(runtime.pythonVersion, 100) ? { pythonVersion: asString(runtime.pythonVersion, 100)! } : {}) }, workspace, createdAt } };
}
