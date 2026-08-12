import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import type { TFunction } from 'i18next';

/**
 * 能力扩展区投影：将 PlatformOverview 中的模块元数据投影为
 * 技能 / 数据 / 知识三类能力条目。
 * 视觉层不得自行推测服务端状态，这里只消费 PlatformOverview 已有字段。
 */

export type CapabilityCategory = 'skill' | 'data' | 'knowledge';

export type CapabilityItem = {
  id: string;
  name: string;
  category: CapabilityCategory;
  source: string;
  status: 'ready' | 'attention' | 'disabled';
  statusLabel: string;
  moduleId: string;
  moduleName: string;
  moduleVersion: string;
  moduleType: PlatformModule['type'];
  moduleRemovable: boolean;
  moduleOrigin: PlatformModule['origin'];
  moduleExtensions: number;
  moduleSkills: number;
  moduleAssets: PlatformModule['assets'];
  skillFiles: PlatformModule['skillFiles'];
  assetId?: string;
};

export const CAPABILITY_CATEGORIES: Array<{ id: CapabilityCategory; labelKey: string }> = [
  { id: 'skill', labelKey: 'capability.category.skill' },
  { id: 'data', labelKey: 'capability.category.data' },
  { id: 'knowledge', labelKey: 'capability.category.knowledge' },
];

function readableName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\.(json|ya?ml|md)$/i, '')
    .trim();
}

function moduleOriginLabel(module: PlatformModule, t: TFunction) {
  return module.origin === 'installed' ? t('settings.module.origin.installed') : module.origin === 'external' ? t('settings.module.origin.external') : t('settings.module.origin.builtin');
}

export function projectCapabilities(overview: PlatformOverview, t: TFunction): CapabilityItem[] {
  const items: CapabilityItem[] = [];
  const activeKinds = new Set(
    overview.modules.flatMap((item) => item.assets.filter((asset) => asset.active).map((asset) => asset.kind)),
  );

  for (const module of overview.modules) {
    const missingAssets = module.assets.filter((asset) => !asset.configured && !activeKinds.has(asset.kind));
    const disabled = !module.enabled;

    const itemStatus = (): CapabilityItem['status'] => {
      if (disabled) return 'disabled';
      if (missingAssets.length) return 'attention';
      return 'ready';
    };
    const itemStatusLabel = () => {
      if (disabled) return t('settings.module.status.disabled');
      if (missingAssets.length) return t('capability.pendingConfig');
      return t('settings.module.status.enabled');
    };
    const source = `${module.version} · ${moduleOriginLabel(module, t)}`;

    // 技能：模块声明的 Skill 数量
    if (module.skills > 0) {
      items.push({
        id: `skill:${module.id}`,
        name: `${module.name} Skill`,
        category: 'skill',
        source: `${t('common.skillCount', { count: module.skills })} · ${source}`,
        status: itemStatus(),
        statusLabel: itemStatusLabel(),
        moduleId: module.id,
        moduleName: module.name,
        moduleVersion: module.version,
        moduleType: module.type,
        moduleRemovable: module.removable,
        moduleOrigin: module.origin,
        moduleExtensions: module.extensions,
        moduleSkills: module.skills,
        moduleAssets: module.assets,
        skillFiles: module.skillFiles || [],
      });
    }

    // 数据与知识：逐个资产展开
    for (const asset of module.assets) {
      if (asset.kind !== 'data' && asset.kind !== 'knowledge') continue;
      const category = asset.kind === 'data' ? 'data' : 'knowledge';
      items.push({
        id: `${category}:${module.id}:${asset.id}`,
        name: readableName(asset.id) || module.name,
        category,
        source: `${module.name} · ${source}`,
        status: disabled ? 'disabled' : !asset.configured && !activeKinds.has(asset.kind) ? 'attention' : 'ready',
        statusLabel: disabled ? t('settings.module.status.disabled') : !asset.configured && !activeKinds.has(asset.kind) ? t('capability.pendingConfig') : t('settings.module.status.enabled'),
        moduleId: module.id,
        moduleName: module.name,
        moduleVersion: module.version,
        moduleType: module.type,
        moduleRemovable: module.removable,
        moduleOrigin: module.origin,
        moduleExtensions: module.extensions,
        moduleSkills: module.skills,
        moduleAssets: module.assets,
        skillFiles: module.skillFiles || [],
        assetId: asset.id,
      });
    }
  }

  return items;
}
