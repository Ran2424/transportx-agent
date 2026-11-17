import { readFileSync } from 'node:fs';
import { Type as T, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { ResilienceComparePlansSchema, ResilienceEventAlignmentSchema, ResilienceJointSensitivitySchema } from '../../../../../src/contracts/tool-definitions.mts';
import { comparePlans, publishAccessibility, publishEventAlignment, publishJointSensitivity, publishJson } from './decision-tools.ts';
import { method } from './workspace-run.ts';
import { digest, publish, readInput } from './workspace-files.ts';

const fields = { additionalProperties: false };
const { casePath, eventPath, calendarPath, toleranceMeters } = ResilienceEventAlignmentSchema.properties;
const { planPath, alignment } = ResilienceComparePlansSchema.properties;
const { stateId, periodId, axes, constraints } = ResilienceJointSensitivitySchema.properties;
const { planId } = ResilienceComparePlansSchema.properties;
const WorkflowSchema = T.Object({
  casePath, eventPath, calendarPath, toleranceMeters, planPath,
  view: T.Object({ stateId, periodId, planId }, fields),
  review: T.Optional(T.Object({ stateId, eventIds: alignment.properties.eventIds }, fields)),
  sensitivity: T.Object({ stateId, periodId, axes, constraints }, fields),
}, fields);
type Workflow = Static<typeof WorkflowSchema>;

function example(cwd: string): Workflow {
  const store = (name: string) => {
    const data = readFileSync(new URL('../../examples/' + name, import.meta.url), 'utf8');
    return publish(cwd, 'resilience-' + digest(data).slice(0, 20) + '-' + name, data).path;
  };
  return {
    casePath: store('decision-case.exercise.json'), eventPath: store('decision-events.exercise.geojson'),
    calendarPath: store('decision-calendar.exercise.json'), planPath: store('decision-plans.exercise.json'),
    view: { stateId: 'east-closed', planId: 'boost-west', periodId: 'peak' },
    review: { stateId: 'east-closed', eventIds: ['east-site-closure'] },
    sensitivity: { stateId: 'ready', periodId: 'peak', axes: [
      { variable: 'unavailable-resource', objectId: 'east-power', values: [false, true] },
      { variable: 'unavailable-resource', objectId: 'west-power', values: [false, true] },
    ], constraints: { maxPriorityShortage: 10, maxTotalShortage: 10 } },
  };
}

export function runDecisionWorkflow(cwd: string, configPath?: string) {
  const input = configPath ? readInput(cwd, configPath) : undefined;
  const config: unknown = input ? JSON.parse(input.text) : example(cwd);
  if (!Value.Check(WorkflowSchema, config)) throw new Error('Invalid resilience workflow configuration. See the module case and workflow examples.');
  const aligned = publishEventAlignment(cwd, config);
  const comparison = comparePlans(cwd, {
    casePath: config.casePath, planPath: config.planPath, ...config.view,
    ...(config.review ? { alignment: { path: aligned.path, sha256: aligned.sha256, ...config.review } } : {}),
  });
  const resolvedCase = { casePath: comparison.files.case.path, caseSha256: comparison.files.case.sha256 };
  const access = publishAccessibility(cwd, { ...resolvedCase, ...comparison.view });
  const sensitivity = publishJointSensitivity(cwd, { ...resolvedCase, ...config.sensitivity });
  const { path: alignmentPath, sha256: alignmentHash } = aligned;
  const { path: accessPath, sha256: accessHash } = access;
  const { path: sensitivityPath, sha256: sensitivityHash } = sensitivity;
  const files = {
    alignment: { path: alignmentPath, sha256: alignmentHash },
    definition: comparison.definition, case: comparison.files.case, comparison: comparison.files.comparison,
    pressure: comparison.files.pressure, map: comparison.files.map, capacityReport: comparison.files.report,
    accessibility: { path: accessPath, sha256: accessHash }, routes: access.map,
    sensitivity: { path: sensitivityPath, sha256: sensitivityHash }, investigation: comparison.files.investigation,
  };
  const summary = {
    confirmedEvents: comparison.appliedEventIds.length, pendingRows: aligned.summary.pendingRows,
    accessLostCohorts: access.summary.accessLostCohorts, sensitivityPoints: sensitivity.pointCount,
    jointInteractions: sensitivity.interactionCount,
  };
  const inputs = { config: input ? { path: configPath, sha256: input.sha256 } : null, ...config };
  const runId = digest(JSON.stringify({ method, inputs, files }));
  const reportBody = [
    '# 城市服务韧性 · 证据到复核', '',
    comparison.provenance.kind === 'exercise' ? '**本次为合成演练。**' : '**服务缺口和绕行结果为情景估算。**', '',
    '## 事件与时段对齐', '',
    `共对齐 ${aligned.summary.events} 项事件，${summary.confirmedEvents} 项经指定复核后进入分析。${summary.pendingRows} 条记录待复核。详见 \`${files.alignment.path}\`。`, '',
    '## 方案比较与容量缺口', '',
    '| 状态 | 方案 | 优先缺口 | 总缺口 |', '| --- | --- | ---: | ---: |',
    ...comparison.scenarioTotals.map(item => `| \`${item.stateId}\` | \`${item.planId}\` | ${item.priorityShortage} | ${item.shortage} |`), '',
    `方案改动与回放依据 \`${files.definition.path}\`。完整比较及调查排序 \`${files.capacityReport.path}\`。`, '',
    '## 网络可达性', '',
    `本时段分析 ${access.summary.cohorts} 个需求组。${summary.accessLostCohorts} 个需求组从阈值内变为不可达或超出阈值，受影响需求 ${access.summary.accessLostDemand} 人次。路线与时间见 \`${files.accessibility.path}\`。`, '',
    '## 联合敏感性与调查线索', '',
    `试算 ${sensitivity.pointCount} 个组合。发现 ${sensitivity.transitionCount} 个相邻方案变化或约束变化，${sensitivity.interactionCount} 项单因素试算没有暴露的联合影响。`, '',
    ...sensitivity.candidateQuestions.map(question => '- ' + question), '',
    `所有试算点和候选问题的依据 \`${files.sensitivity.path}\`。已有调查的期限与方案取舍 \`${files.investigation.path}\`。`, '',
    '## 复核文件', '',
    `- 方案比较 CSV · \`${files.comparison.path}\``,
    `- 中断影响 GeoJSON · \`${files.map.path}\``,
    `- 最短通路 GeoJSON · \`${files.routes.path}\``, '',
  ].join('\n');
  const report = publish(cwd, 'resilience-' + runId.slice(0, 20) + '-workflow-report.md', reportBody);
  const manifest = publishJson(cwd, 'workflow-manifest.json', {
    protocol: 'transportx-resilience-decision-workflow', version: 1, method, runId, inputs,
    provenance: comparison.provenance, view: comparison.view, summary, files: { ...files, report },
  });
  return { runId, summary, files: { ...files, report, manifest }, reportBody };
}
