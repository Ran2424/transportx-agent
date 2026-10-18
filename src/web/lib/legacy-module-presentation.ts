import type { ModulePresentation, ModulePresentationText } from '../../contracts/module';

type Copy = [name: string, description: string, ...features: string[]];

function legacyPresentation(zh: Copy, en: Copy, assetIds: string[] = []): ModulePresentation {
  const text = ([name, description, ...features]: Copy): ModulePresentationText => ({ name, description, features });
  const base = { defaultLocale: 'zh-CN' as const, locales: { 'zh-CN': text(zh), 'en-US': text(en) } };
  return { ...base, ...(assetIds.length ? { assets: Object.fromEntries(assetIds.map((id) => [id, base])) } : {}) };
}

// Display-only compatibility for packages released before presentation metadata.
// Package-provided metadata takes precedence; runtime files and identities stay intact.
export const LEGACY_MODULE_PRESENTATIONS: Record<string, ModulePresentation> = {
  'com.transportx.hongqiao-metro-demo': legacyPresentation(
    ['虹桥地铁入口视频与人数示例',
      '提供 2026-06-30 虹桥枢纽地铁入口录像与逐秒可见人数估计，支持录像回看和人数变化分析。',
      '按绝对时间定位入口录像', '查看逐秒可见人数变化及峰值', '人数指标为画面估计，不等同进出站人次'],
    ['Hongqiao Metro Entrance Video & Occupancy Demo',
      'Provides Hongqiao metro entrance video from 2026-06-30 and per-second visible-person estimates for review and occupancy analysis.',
      'Seeks entrance recordings by absolute time', 'Examines visible-person trends and peaks', 'Uses estimated visible occupancy rather than entry and exit counts'],
    ['data:hongqiao-metro-demo'],
  ),
  'com.transportx.shanghai-hub-traffic': legacyPresentation(
    ['上海枢纽交通数据',
      '查询上海机场与铁路枢纽相关数据，覆盖铁路班次、地铁客流、到达预测、出租车与网约车需求。',
      '查询铁路到发、上下客和虹桥地铁客流', '查看到达预测与疏散方式比例', '分析蓄车场、功能点流量和网约车需求'],
    ['Shanghai Hub Traffic Data',
      'Queries Shanghai airport and railway-hub data covering trains, metro flow, arrival forecasts, taxi yards and ride-hailing demand.',
      'Queries train movements, boarding and alighting, and Hongqiao metro flow', 'Examines arrival forecasts and evacuation mode ratios', 'Analyzes taxi yards, site observations and ride-hailing demand'],
    ['data:shanghai-hub-traffic'],
  ),
  'com.transportx.shanghai-multimodal-data': legacyPresentation(
    ['上海多方式交通数据快照',
      '查询 2026-08-24 上海多方式交通快照，覆盖轨交、公交、出租车、网约车、共享单车及站点周边数据。',
      '按交通方式、时段和网格查询数据', '查看站点周边设施与空间关系', '数据仅覆盖单日快照，不能据此推断长期趋势'],
    ['Shanghai Multimodal Traffic Snapshot',
      'Queries the 2026-08-24 Shanghai snapshot covering metro, bus, taxi, ride-hailing, shared bikes and station surroundings.',
      'Queries data by mode, time period and grid', 'Examines nearby facilities and spatial relationships', 'Covers one day and does not establish long-term trends'],
    ['data:shanghai-multimodal-20260824'],
  ),
  'com.transportx.shanghai-transit-gis': legacyPresentation(
    ['上海交通 GIS',
      '查询上海轨道站线、随申行公交、参考道路和历史行政区划，为交通空间分析提供基础数据。',
      '查询轨道站点、线路及线路内站序', '查看随申行 2026-08-24 公交线路与停靠实例', '按范围筛选参考道路；历史区划不代表现行法定边界'],
    ['Shanghai Transit GIS',
      'Queries Shanghai rail stations and lines, Suishenxing buses, reference roads and historical administrative boundaries for spatial analysis.',
      'Queries rail stations, lines and station order', 'Examines bus lines and stop instances from the 2026-08-24 Suishenxing snapshot', 'Filters reference roads by area; historical divisions are not current legal boundaries'],
    ['data:shanghai-transit-gis'],
  ),
  'com.transportx.shanghaidata': legacyPresentation(
    ['上海体育场活动交通数据',
      '围绕 2025 年上海体育场时代少年团演唱会案例，查询活动安排、路网、客流、道路状态、订单与天气数据。',
      '按演前、演中和散场阶段组织交通分析', '关联轨交、道路、网约车和场馆周边数据', '核对指标、数据质量及并发活动影响'],
    ['Shanghai Stadium Event Traffic Data',
      'Queries event schedules, networks, passenger flow, road conditions, orders and weather for the 2025 TNT concert case at Shanghai Stadium.',
      'Organizes analysis around pre-event, during-event and dispersal stages', 'Relates metro, road, ride-hailing and venue-area data', 'Checks metrics, data quality and concurrent-event effects'],
    ['data:shanghai-traffic'],
  ),
  'com.transportx.suishenxing-data': legacyPresentation(
    ['随申行交通业务观测',
      '查询 2026-08-24 随申行轨交、公交、共享单车、出租车与网约车观测，并关联交通 GIS 与网格。',
      '区分物理轨道站统计与线路内站点统计', '按公交线路、小时和业务网格查询观测', '不同交通方式量纲不同；单日数据不能推断长期趋势'],
    ['Suishenxing Traffic Observations',
      'Queries 2026-08-24 Suishenxing metro, bus, shared-bike, taxi and ride-hailing observations linked to transit GIS and grids.',
      'Distinguishes physical-station totals from station-by-line observations', 'Queries observations by bus line, hour and business grid', 'Modes use different units; one-day observations do not establish long-term trends'],
    ['data:suishenxing-observations'],
  ),
  'com.transportx.traffic-assurance-knowledge': legacyPresentation(
    ['重大活动交通保障知识库',
      '检索交通保障相关法规、标准、预案和活动案例，定位可核验的原文依据。',
      '按目录、文档层级和检索结果查找资料', '核对条款、来源位置和 PDF 页码', '辅助编制保障方案、应急预案与检查清单'],
    ['Major-Event Traffic Assurance Knowledge Base',
      'Searches traffic-assurance laws, standards, plans and event cases to locate verifiable sources.',
      'Finds material through catalogs, document hierarchies and search results', 'Checks clauses, source locations and PDF pages', 'Supports traffic-assurance plans, emergency plans and checklists'],
    ['knowledge:traffic-assurance'],
  ),
  'com.transportx.plot-style': legacyPresentation(
    ['科研图表样式', '为数据分析图表提供可复用的 Matplotlib 样式与绘图方法。',
      '按数据与用途选择图表形式', '统一字体、配色、标注与导出格式'],
    ['Scientific Chart Styles', 'Provides reusable Matplotlib styles and plotting methods for analytical figures.',
      'Selects chart types for the data and purpose', 'Coordinates fonts, colors, annotations and export formats'],
  ),
  'com.transportx.video': legacyPresentation(
    ['视频查询与处理', '按地点和时间检索本地录像，支持播放定位、截图、抽帧与片段截取。',
      '按录像绝对时间定位和并排对比画面', '截图与采样帧供视觉模型分析', '截取最长五分钟的片段并保留录像时间'],
    ['Video Query & Processing', 'Searches local recordings by place and time, with playback, snapshots, frame sampling and clipping.',
      'Seeks and compares recordings using absolute recording times', 'Provides snapshots and sampled frames for visual-model analysis', 'Clips up to five minutes while preserving recording times'],
  ),
};
