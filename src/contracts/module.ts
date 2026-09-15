import { asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { unknownVersionDiagnostic } from './version.ts';

export const MODULE_MANIFEST_VERSION = 2 as const;
export const MODULE_TYPES = ['module', 'capability', 'domain'] as const;
export type ModuleType = typeof MODULE_TYPES[number];

export type ModuleAsset = {
  id: string;
  kind: 'knowledge' | 'data' | 'template';
  path: string;
  required?: boolean;
  integrityFile?: string;
};

export type ModuleNativeRuntime = {
  id: string;
  kind: 'ffmpeg';
  platform: 'darwin' | 'win32';
  arch: 'arm64' | 'x64';
  version: string;
  executables: {
    ffmpeg: { path: string; sha256: string };
    ffprobe: { path: string; sha256: string };
  };
  notices?: string;
};

export type ModuleManifest = {
  manifestVersion: 2;
  id: string;
  name: string;
  version: string;
  type: ModuleType;
  platformVersion: string;
  dependencies: string[];
  entrypoints?: {
    piExtensions?: string[];
    skills?: string[];
    prompts?: string[];
  };
  contributes?: {
    artifactTypes?: string[];
    assets?: ModuleAsset[];
    nativeRuntimes?: ModuleNativeRuntime[];
    requiredNativeRuntimes?: string[];
  };
};

export type ModuleArchiveCandidate = {
  id: string;
  name: string;
  version: string;
  type: ModuleType;
  dependencies: string[];
  skills: number;
  extensions: number;
  assets: number;
  nativeRuntimes: number;
  uncompressedBytes: number;
  status: 'ready' | 'installed' | 'conflict' | 'invalid';
  message?: string;
};

export type ModuleArchiveInspection = {
  importId: string;
  sourceName: string;
  compressedBytes: number;
  uncompressedBytes: number;
  modules: ModuleArchiveCandidate[];
};

export type ModuleManifestParseResult =
  | { ok: true; value: ModuleManifest; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

function stringList(value: unknown, path: string, diagnostics: ContractDiagnostic[]) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !asString(item, 500))) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an array of non-empty strings.' }));
    return undefined;
  }
  return value.map((item) => String(item).trim());
}

function requiredText(record: JsonRecord, key: string, diagnostics: ContractDiagnostic[], max = 200) {
  const value = asString(record[key], max);
  if (!value) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `$.${key}`, message: `${key} is required.` }));
  return value;
}

export function parseModuleManifestStructured(input: unknown): ModuleManifestParseResult {
  const diagnostics: ContractDiagnostic[] = [];
  const record = asRecord(input);
  if (!record) return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: '$', message: 'Module manifest must be an object.' })] };
  if (record.manifestVersion !== MODULE_MANIFEST_VERSION) diagnostics.push(unknownVersionDiagnostic({ path: '$.manifestVersion', field: 'schemaVersion', received: record.manifestVersion, expected: MODULE_MANIFEST_VERSION }));
  const id = requiredText(record, 'id', diagnostics);
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) diagnostics.push(diagnostic({ code: 'unsupported_value', path: '$.id', message: 'id may contain only letters, numbers, dots, underscores and hyphens.' }));
  const name = requiredText(record, 'name', diagnostics);
  const version = requiredText(record, 'version', diagnostics);
  const platformVersion = requiredText(record, 'platformVersion', diagnostics);
  const type = asString(record.type, 40) as ModuleType | null;
  if (!type || !(MODULE_TYPES as readonly string[]).includes(type)) diagnostics.push(diagnostic({ code: 'unsupported_value', path: '$.type', message: `Expected one of: ${MODULE_TYPES.join(', ')}.` }));
  const dependencies = stringList(record.dependencies, '$.dependencies', diagnostics);
  if (!dependencies) diagnostics.push(diagnostic({ code: 'missing_required_field', path: '$.dependencies', message: 'dependencies is required.' }));

  const entrypointsRecord = record.entrypoints === undefined ? null : asRecord(record.entrypoints);
  if (record.entrypoints !== undefined && !entrypointsRecord) diagnostics.push(diagnostic({ code: 'invalid_type', path: '$.entrypoints', message: 'entrypoints must be an object.' }));
  const contributesRecord = record.contributes === undefined ? null : asRecord(record.contributes);
  if (record.contributes !== undefined && !contributesRecord) diagnostics.push(diagnostic({ code: 'invalid_type', path: '$.contributes', message: 'contributes must be an object.' }));
  const piExtensions = entrypointsRecord ? stringList(entrypointsRecord.piExtensions, '$.entrypoints.piExtensions', diagnostics) : undefined;
  const skills = entrypointsRecord ? stringList(entrypointsRecord.skills, '$.entrypoints.skills', diagnostics) : undefined;
  const prompts = entrypointsRecord ? stringList(entrypointsRecord.prompts, '$.entrypoints.prompts', diagnostics) : undefined;
  const artifactTypes = contributesRecord ? stringList(contributesRecord.artifactTypes, '$.contributes.artifactTypes', diagnostics) : undefined;
  const requiredNativeRuntimes = contributesRecord ? stringList(contributesRecord.requiredNativeRuntimes, '$.contributes.requiredNativeRuntimes', diagnostics) : undefined;

  const assets: ModuleAsset[] = [];
  if (contributesRecord?.assets !== undefined) {
    if (!Array.isArray(contributesRecord.assets)) diagnostics.push(diagnostic({ code: 'invalid_type', path: '$.contributes.assets', message: 'assets must be an array.' }));
    else contributesRecord.assets.forEach((item, index) => {
      const asset = asRecord(item);
      const assetId = asset && asString(asset.id, 200);
      const assetPath = asset && asString(asset.path, 500);
      const kind = asset && asString(asset.kind, 40);
      if (!asset || !assetId || !assetPath || !['knowledge', 'data', 'template'].includes(kind || '')) {
        diagnostics.push(diagnostic({ code: 'invalid_type', path: `$.contributes.assets[${index}]`, message: 'Asset requires id, kind and path.' }));
      } else assets.push({ id: assetId, kind: kind as ModuleAsset['kind'], path: assetPath, ...(typeof asset.required === 'boolean' ? { required: asset.required } : {}), ...(asString(asset.integrityFile, 500) ? { integrityFile: asString(asset.integrityFile, 500)! } : {}) });
    });
  }

  const nativeRuntimes: ModuleNativeRuntime[] = [];
  if (contributesRecord?.nativeRuntimes !== undefined) {
    if (!Array.isArray(contributesRecord.nativeRuntimes)) diagnostics.push(diagnostic({ code: 'invalid_type', path: '$.contributes.nativeRuntimes', message: 'nativeRuntimes must be an array.' }));
    else contributesRecord.nativeRuntimes.forEach((item, index) => {
      const runtime = asRecord(item);
      const executables = asRecord(runtime?.executables);
      const ffmpeg = asRecord(executables?.ffmpeg);
      const ffprobe = asRecord(executables?.ffprobe);
      const id = asString(runtime?.id, 200);
      const kind = asString(runtime?.kind, 40);
      const platform = asString(runtime?.platform, 40);
      const arch = asString(runtime?.arch, 40);
      const version = asString(runtime?.version, 100);
      const ffmpegPath = asString(ffmpeg?.path, 500);
      const ffprobePath = asString(ffprobe?.path, 500);
      const ffmpegSha256 = asString(ffmpeg?.sha256, 64);
      const ffprobeSha256 = asString(ffprobe?.sha256, 64);
      if (!runtime || !id || kind !== 'ffmpeg' || !['darwin', 'win32'].includes(platform || '') || !['arm64', 'x64'].includes(arch || '') || !version || !ffmpegPath || !ffprobePath || !ffmpegSha256?.match(/^[a-f0-9]{64}$/i) || !ffprobeSha256?.match(/^[a-f0-9]{64}$/i)) {
        diagnostics.push(diagnostic({ code: 'invalid_type', path: `$.contributes.nativeRuntimes[${index}]`, message: 'Native runtime requires an id, supported platform/architecture, version, and SHA-256 executable entries.' }));
      } else nativeRuntimes.push({
        id,
        kind: 'ffmpeg',
        platform: platform as ModuleNativeRuntime['platform'],
        arch: arch as ModuleNativeRuntime['arch'],
        version,
        executables: {
          ffmpeg: { path: ffmpegPath, sha256: ffmpegSha256.toLowerCase() },
          ffprobe: { path: ffprobePath, sha256: ffprobeSha256.toLowerCase() },
        },
        ...(asString(runtime.notices, 500) ? { notices: asString(runtime.notices, 500)! } : {}),
      });
    });
  }

  if (diagnostics.length || !id || !name || !version || !platformVersion || !type || !dependencies) return { ok: false, value: null, diagnostics };
  return {
    ok: true,
    diagnostics: [],
    value: {
      manifestVersion: 2,
      id,
      name,
      version,
      type,
      platformVersion,
      dependencies,
      ...(entrypointsRecord ? { entrypoints: {
        ...(piExtensions ? { piExtensions } : {}),
        ...(skills ? { skills } : {}),
        ...(prompts ? { prompts } : {}),
      } } : {}),
      ...(contributesRecord ? { contributes: {
        ...(artifactTypes ? { artifactTypes } : {}),
        ...(assets.length ? { assets } : {}),
        ...(nativeRuntimes.length ? { nativeRuntimes } : {}),
        ...(requiredNativeRuntimes ? { requiredNativeRuntimes } : {}),
      } } : {}),
    },
  };
}

export function parseModuleManifest(input: unknown) {
  const result = parseModuleManifestStructured(input);
  return result.ok ? result.value : null;
}
