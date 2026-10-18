import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import type { TFunction } from 'i18next';
import { moduleDisplayMetadata, modulePresentation, moduleSearchText } from '../../lib/module-presentation';

/**
 * 能力扩展区投影：将 PlatformOverview 中的模块元数据投影为
 * 技能、工具与资源条目。
 * 视觉层不得自行推测服务端状态，这里只消费 PlatformOverview 已有字段。
 */

export type CapabilityCategory = 'skill' | 'data' | 'knowledge' | 'tool' | 'template';

export type CapabilityItem = {
  id: string;
  name: string;
  description: string;
  features: string[];
  searchText: string;
  category: CapabilityCategory;
  status: 'ready' | 'attention' | 'disabled';
  statusLabel: string;
  moduleId: string;
  moduleName: string;
  moduleVersion: string;
  moduleType: PlatformModule['type'];
  moduleRemovable: boolean;
  moduleOrigin: PlatformModule['origin'];
  moduleAssets: Array<PlatformModule['assets'][number] & { name: string }>;
  skillFiles: PlatformModule['skillFiles'];
  assetId?: string;
};

export const CAPABILITY_CATEGORIES: Array<{ id: CapabilityCategory; labelKey: string }> = [
  { id: 'skill', labelKey: 'capability.category.skill' },
  { id: 'data', labelKey: 'capability.category.data' },
  { id: 'knowledge', labelKey: 'capability.category.knowledge' },
  { id: 'tool', labelKey: 'capability.category.tool' },
  { id: 'template', labelKey: 'capability.category.template' },
];

function readableName(value: string) {
  return value
    .replace(/^(data|knowledge|template):/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\.(json|ya?ml|md)$/i, '')
    .trim();
}

export function projectCapabilities(overview: PlatformOverview, t: TFunction, language: string): CapabilityItem[] {
  const items: CapabilityItem[] = [];
  for (const entry of overview.modules) {
    const module = { ...entry, presentation: moduleDisplayMetadata(entry) };
    const moduleText = modulePresentation(module, language);
    const skillPath = module.skillFiles?.length === 1 ? module.skillFiles[0].entryPath : undefined;
    const text = modulePresentation(module, language, { skillPath });
    const description = text.description || module.skillFiles?.map((file) => file.description).filter(Boolean).join('\n') || t('capability.noDescription');
    const features = text.features;
    const searchText = moduleSearchText(module);
    const moduleAssets = module.assets.map((asset) => ({ ...asset, name: module.presentation ? modulePresentation(module, language, { assetId: asset.id }).name : readableName(asset.id) || module.name }));
    const skillFiles = (module.skillFiles || []).map((file) => ({ ...file, name: module.presentation ? modulePresentation(module, language, { skillPath: file.entryPath }).name : file.name }));
    const missingAssets = module.assets.filter((asset) => !asset.configured || asset.error);
    const hasError = overview.errors.some((error) => error.moduleId === module.id) || module.skillFiles?.some((file) => file.error);
    const disabled = !module.enabled;

    const itemStatus = (): CapabilityItem['status'] => {
      if (disabled) return 'disabled';
      if (missingAssets.length || hasError) return 'attention';
      return 'ready';
    };
    const itemStatusLabel = () => {
      if (disabled) return t('settings.module.status.disabled');
      if (hasError) return t('capability.moduleError');
      if (module.assets.some((asset) => asset.error)) return t('capability.resourceError');
      if (missingAssets.length) return t('capability.pendingConfig');
      return t('settings.module.status.enabled');
    };
    // 有 Skill 的模块展示用途；纯扩展模块作为工具展示。
    if (module.skills > 0 || module.extensions > 0) {
      const category = module.skills > 0 ? 'skill' : 'tool';
      items.push({
        id: `${category}:${module.id}`,
        name: module.presentation ? text.name : module.skillFiles?.length === 1 && module.skillFiles[0].name !== 'SKILL.md' ? module.skillFiles[0].name : module.name,
        description,
        features,
        searchText,
        category,
        status: itemStatus(),
        statusLabel: itemStatusLabel(),
        moduleId: module.id,
        moduleName: moduleText.name,
        moduleVersion: module.version,
        moduleType: module.type,
        moduleRemovable: module.removable,
        moduleOrigin: module.origin,
        moduleAssets,
        skillFiles,
      });
    }

    // 资源：逐个资产展开，配置状态只对应具体资产。
    for (const asset of module.assets) {
      const category = asset.kind;
      items.push({
        id: `${category}:${module.id}:${asset.id}`,
        name: module.presentation ? modulePresentation(module, language, { assetId: asset.id }).name : readableName(asset.id) || module.name,
        description: module.presentation ? modulePresentation(module, language, { assetId: asset.id }).description : description,
        features: module.presentation ? modulePresentation(module, language, { assetId: asset.id }).features : features,
        searchText,
        category,
        status: disabled ? 'disabled' : !asset.configured || asset.error ? 'attention' : 'ready',
        statusLabel: disabled ? t('settings.module.status.disabled') : asset.error ? t('capability.resourceError') : !asset.configured ? t('capability.pendingConfig') : t('capability.configured'),
        moduleId: module.id,
        moduleName: moduleText.name,
        moduleVersion: module.version,
        moduleType: module.type,
        moduleRemovable: module.removable,
        moduleOrigin: module.origin,
        moduleAssets,
        skillFiles,
        assetId: asset.id,
      });
    }
  }

  return items.sort((a, b) => CAPABILITY_CATEGORIES.findIndex((category) => category.id === a.category)
    - CAPABILITY_CATEGORIES.findIndex((category) => category.id === b.category));
}
