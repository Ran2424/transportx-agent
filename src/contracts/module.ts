import { asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { unknownVersionDiagnostic } from './version.ts';

export const MODULE_MANIFEST_VERSION = 2 as const;
export const MODULE_TYPES = ['module', 'capability', 'domain'] as const;
export type ModuleType = typeof MODULE_TYPES[number];

export type ModulePresentationLocale = 'zh-CN' | 'en-US';
export type ModulePresentationText = { name: string; description: string; features?: string[] };
export type ModuleLocalizedPresentation = {
  defaultLocale: ModulePresentationLocale;
  locales: Partial<Record<ModulePresentationLocale, ModulePresentationText>>;
};
export type ModulePresentation = ModuleLocalizedPresentation & {
  skills?: Record<string, ModuleLocalizedPresentation>;
  assets?: Record<string, ModuleLocalizedPresentation>;
};

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

export type ModuleCanvasView = {
  adapterId: string;
  kind: string;
  protocolVersion: string;
};

export type ModuleManifest = {
  manifestVersion: 2;
  id: string;
  name: string;
  version: string;
  type: ModuleType;
  presentation?: ModulePresentation;
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
    canvasViews?: ModuleCanvasView[];
  };
};

export type ModuleArchiveCandidate = {
  id: string;
  name: string;
  presentation?: ModulePresentation;
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

function localizedPresentation(value: unknown, field: string, diagnostics: ContractDiagnostic[]): ModuleLocalizedPresentation | undefined {
  const record = asRecord(value);
  const locales = asRecord(record?.locales);
  const defaultLocale = record?.defaultLocale;
  const invalid = (path: string) => diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected localized names, descriptions and optional feature lists for zh-CN/en-US.' }));
  if (!record || !locales || (defaultLocale !== 'zh-CN' && defaultLocale !== 'en-US') || !locales[defaultLocale]) { invalid(field); return undefined; }
  const parsed: ModuleLocalizedPresentation['locales'] = {};
  for (const [locale, candidate] of Object.entries(locales)) {
    if (locale !== 'zh-CN' && locale !== 'en-US') { invalid(`${field}.locales.${locale}`); continue; }
    const text = asRecord(candidate);
    const name = asString(text?.name, 200);
    const description = asString(text?.description, 2000);
    const features = text?.features === undefined ? undefined : stringList(text.features, `${field}.locales.${locale}.features`, diagnostics);
    if (!name || !description || (features && features.length > 12)) { invalid(`${field}.locales.${locale}`); continue; }
    parsed[locale] = { name, description, ...(features ? { features } : {}) };
  }
  return { defaultLocale, locales: parsed };
}

function modulePresentation(value: unknown, skills: string[], assets: ModuleAsset[], diagnostics: ContractDiagnostic[]): ModulePresentation | undefined {
  if (value === undefined) return undefined;
  const base = localizedPresentation(value, '$.presentation', diagnostics);
  if (!base) return undefined;
  const record = asRecord(value)!;
  const result: ModulePresentation = { ...base };
  for (const kind of ['skills', 'assets'] as const) {
    if (record[kind] === undefined) continue;
    const overrides = asRecord(record[kind]);
    if (!overrides) { diagnostics.push(diagnostic({ code: 'invalid_type', path: `$.presentation.${kind}`, message: 'Expected a map of declared Skill paths or asset IDs.' })); continue; }
    const allowed = new Set(kind === 'skills' ? skills : assets.map((asset) => asset.id));
    const entries: Array<[string, ModuleLocalizedPresentation]> = [];
    for (const [id, candidate] of Object.entries(overrides)) {
      if (!allowed.has(id)) { diagnostics.push(diagnostic({ code: 'unsupported_value', path: `$.presentation.${kind}.${id}`, message: 'Presentation entry must refer to a declared Skill or asset.' })); continue; }
      const parsed = localizedPresentation(candidate, `$.presentation.${kind}.${id}`, diagnostics);
      if (parsed) entries.push([id, parsed]);
    }
    result[kind] = Object.fromEntries(entries);
  }
  return result;
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

  const canvasViews: ModuleCanvasView[] = [];
  if (contributesRecord?.canvasViews !== undefined) {
    if (!Array.isArray(contributesRecord.canvasViews)) diagnostics.push(diagnostic({ code: 'invalid_type', path: '$.contributes.canvasViews', message: 'canvasViews must be an array.' }));
    else contributesRecord.canvasViews.forEach((item, index) => {
      const view = asRecord(item);
      const adapterId = asString(view?.adapterId, 200);
      const kind = asString(view?.kind, 80);
      const protocolVersion = asString(view?.protocolVersion, 40);
      if (!view || !adapterId || !kind || !protocolVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(adapterId) || Object.keys(view).some((key) => !['adapterId', 'kind', 'protocolVersion'].includes(key))) {
        diagnostics.push(diagnostic({ code: 'invalid_type', path: `$.contributes.canvasViews[${index}]`, message: 'Canvas view requires adapterId, kind and protocolVersion.' }));
      } else if (canvasViews.some((candidate) => candidate.adapterId === adapterId)) {
        diagnostics.push(diagnostic({ code: 'duplicate_id', path: `$.contributes.canvasViews[${index}].adapterId`, message: `Duplicate Canvas adapterId: ${adapterId}` }));
      } else canvasViews.push({ adapterId, kind, protocolVersion });
    });
  }

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

  const presentation = modulePresentation(record.presentation, skills || [], assets, diagnostics);
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
      ...(presentation ? { presentation } : {}),
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
        ...(canvasViews.length ? { canvasViews } : {}),
      } } : {}),
    },
  };
}

export function parseModuleManifest(input: unknown) {
  const result = parseModuleManifestStructured(input);
  return result.ok ? result.value : null;
}
