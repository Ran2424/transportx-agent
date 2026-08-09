import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';

/**
 * 能力扩展区投影：将 PlatformOverview 中的模块元数据投影为
 * 模块 / 技能 / 数据 / 知识 四类只读条目。
 * 视觉层不得自行推测服务端状态，这里只消费 PlatformOverview 已有字段。
 */

export type CapabilityCategory = 'module' | 'skill' | 'data' | 'knowledge';

export type CapabilityItem = {
  id: string;
  name: string;
  category: CapabilityCategory;
  source: string;
  status: 'ready' | 'attention' | 'disabled';
  statusLabel: string;
};

export const CAPABILITY_CATEGORIES: Array<{ id: CapabilityCategory; label: string }> = [
  { id: 'module', label: '模块' },
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

    // 模块：module / capability / domain 包本体
    if (module.type === 'module' || module.type === 'capability' || module.type === 'domain') {
      items.push({
        id: `module:${module.id}`,
        name: module.name,
        category: 'module',
        source,
        status: itemStatus(),
        statusLabel: itemStatusLabel(),
      });
    }

    // 技能：模块声明的 Skill 数量
    if (module.skills > 0) {
      items.push({
        id: `skill:${module.id}`,
        name: `${module.name} Skill`,
        category: 'skill',
        source: `${module.skills} 项技能 · ${module.id}`,
        status: itemStatus(),
        statusLabel: itemStatusLabel(),
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
        source: module.name,
        status: disabled ? 'disabled' : !asset.configured && !activeKinds.has(asset.kind) ? 'attention' : 'ready',
        statusLabel: disabled ? '不可用' : !asset.configured && !activeKinds.has(asset.kind) ? '待配置' : '已启用',
      });
    }
  }

  return items;
}
