import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';

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

export const CAPABILITY_CATEGORIES: Array<{ id: CapabilityCategory; label: string }> = [
  { id: 'skill', label: '技能' },
  { id: 'data', label: '数据' },
  { id: 'knowledge', label: '知识' },
];

function readableName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\.(json|ya?ml|md)$/i, '')
    .trim();
}

function moduleOriginLabel(module: PlatformModule) {
  return module.origin === 'installed' ? '用户安装' : module.origin === 'external' ? '外部加载' : '内置';
}

export function projectCapabilities(overview: PlatformOverview): CapabilityItem[] {
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
      if (disabled) return '不可用';
      if (missingAssets.length) return '待配置';
      return '已启用';
    };
    const source = `${module.version} · ${moduleOriginLabel(module)}`;

    // 技能：模块声明的 Skill 数量
    if (module.skills > 0) {
      items.push({
        id: `skill:${module.id}`,
        name: `${module.name} Skill`,
        category: 'skill',
        source: `${module.skills} 项技能 · ${source}`,
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
        statusLabel: disabled ? '不可用' : !asset.configured && !activeKinds.has(asset.kind) ? '待配置' : '已启用',
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
