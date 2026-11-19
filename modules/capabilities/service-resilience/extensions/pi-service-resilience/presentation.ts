import type { PressureTestResult } from './engine.ts';
import type { InvestigationRanking, Regret } from './investigation.ts';
import type { ResilienceCase } from './model.ts';
import { networkSlice } from './network-slice.ts';

export type ViewSelection = { stateId: string; planId: string; periodId: string };
const label = (items: { id: string; label: string }[], id: string) => items.find(item => item.id === id)?.label ?? id;
const cell = (text: string) => text.replace(/[\r\n]+/gu, ' ').replace(/[\\|`*_\[\]<>]/gu, '\\$&');
const regret = (value: Regret | null) => value ? `${value.priorityShortage} / ${value.totalShortage}` : '—';

export function renderReport(model: ResilienceCase, pressure: PressureTestResult, ranked: InvestigationRanking, view: ViewSelection,
  runId: string, caseHash: string) {
  const baselineShortage = pressure.baseline.reduce((sum, period) => sum + period.shortage, 0);
  const name = (planId: string | null) => planId === null ? '期限内无可执行方案' : cell(label(model.plans, planId));
  return [
    '# 城市服务中断压力测试',
    '', cell(model.title), '',
    model.provenance.kind === 'exercise' ? '**合成演练假设，仅用于方法推演。**' : '**观测资料输入，情景结果仍为模型估算。**',
    '', cell(model.provenance.note), '',
    `运行 ID \`${runId}\` · 输入 SHA-256 \`${caseHash}\``,
    '',
    '## 服务缺口与恢复方案',
    '',
    `无中断、无新增措施的参考情景仍有 ${baselineShortage} 个服务人次未满足。计量单位为按时段加权的服务需求人次。`,
    '',
    '| 中断状态 | 应对方案 | 优先未满足 | 总未满足 | 较该中断无措施恢复 |',
    '| --- | --- | ---: | ---: | ---: |',
    ...pressure.scenarios.map(row => `| ${cell(label(model.states, row.stateId))} | ${name(row.planId)} | ${row.priorityShortage} | ${row.shortage} | ${row.restored} |`),
    '',
    `地图对应 ${cell(label(model.states, view.stateId))} · ${name(view.planId)} · ${cell(label(model.periods, view.periodId))}。`,
    '',
    '## 主动调查建议',
    '',
    `决定窗口为 ${ranked.decisionWindowMinutes} 分钟。在没有额外观测时，按优先缺口、总缺口的顺序比较最坏后悔值，得到 ${name(ranked.beforeObservation.recommendedPlanId)}。`,
    '',
    '| 调查 | 来源与工作量 | 返回时间 | 最坏后悔值（优先／总量） | 决策方式 |',
    '| --- | --- | --- | ---: | --- |',
    ...ranked.investigations.map(item => `| ${cell(item.question)} | ${cell(item.source)} · ${cell(item.effort)} | ${item.leadMinutes} 分钟${item.timely ? '' : '（晚于决定）'} | ${regret(item.worstRegret)} | ${item.decision === 'wait' ? '可等待后按条件选择' : item.decision === 'act-now' ? '保留立即部署' : '期限内无可执行方案'} |`),
    '',
    ...ranked.investigations.filter(item => item.timely).flatMap(item => [
      `**${cell(item.question)}**`,
      '',
      ...item.outcomes.map(outcome => `- ${cell(outcome.outcome)} → ${name(outcome.recommendedPlanId)}${outcome.remainingAmbiguity ? '（仍有多个可能状态）' : ''}`),
      '',
    ]),
    '## 计算边界',
    '',
    '- 各时段独立。容量竞争通过优先分配体现。累计值是服务需求人次，同一人可在多个时段或服务中重复计入。',
    '- 路网与共享资源的中断先于应对方案生效。行程时间来自输入，未模拟车辆排队、换乘动态、人群行为或抢修排班。',
    '- 调查排序使用列出的状态与调查结果对应关系，未给状态赋予概率。工作量为说明项，遇到排序接近的调查由人衡量成本。',
    '- 条件方案要求观测返回与方案准备均落在决定窗口内。其他实际约束由资料及业务负责人核实。',
    '',
  ].join('\n');
}

export function comparisonCsv(pressure: PressureTestResult) {
  return [
    'state_id,plan_id,period_id,weight,demand,reachable,unreachable,capacity_unmet,served,unmet,priority_unmet',
    ...pressure.scenarios.flatMap(row => row.periods.map(period =>
      [row.stateId, row.planId, period.periodId, period.weight, period.demand, period.reachable, period.unreachable,
        period.capacityUnmet, period.served, period.shortage, period.priorityShortage].join(','))),
    '',
  ].join('\r\n');
}

export function pressureMap(model: ResilienceCase, pressure: PressureTestResult, view: ViewSelection) {
  const { stateId, planId, periodId } = view;
  const state = model.states.find(item => item.id === stateId)!.periods[periodId];
  const plan = model.plans.find(item => item.id === planId)!.periods[periodId];
  const period = pressure.scenarios.find(item => item.stateId === stateId && item.planId === planId)!.periods.find(item => item.periodId === periodId)!;
  const coords = new Map(model.nodes.map(item => [item.id, item.coordinates]));
  const network = networkSlice(model, state, plan);
  const usableEdges = new Set(network.edges.map(edge => edge.id));
  const availableServices = new Map(network.services.map(service => [service.id, service.capacity]));
  const props = (featureId: string, featureKind: string) => ({ feature_id: featureId, feature_kind: featureKind, state_id: stateId, plan_id: planId, period_id: periodId });
  return { type: 'FeatureCollection', features: [
    ...model.edges.map(edge => ({
      type: 'Feature', geometry: { type: 'LineString', coordinates: [coords.get(edge.from)!, coords.get(edge.to)!] },
      properties: { ...props(edge.id, 'edge'), traffic_state: usableEdges.has(edge.id) ? 'available' : 'unavailable' },
    })),
    ...model.services.map(service => {
      return {
        type: 'Feature', geometry: { type: 'Point', coordinates: coords.get(service.node)! },
        properties: { ...props(service.id, 'service'), service_kind: service.kind,
          available_capacity: availableServices.get(service.id) ?? 0, service_open: availableServices.has(service.id) },
      };
    }),
    ...period.cohorts.map(row => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: coords.get(model.demands.find(item => item.id === row.demandId)!.node)! },
      properties: { ...props(row.demandId, 'demand'), service_kind: row.kind, priority: row.priority,
        demand: row.demand, served: row.served, unmet: row.shortage, capacity_unmet: row.capacityUnmet },
    })),
  ] };
}
