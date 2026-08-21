import fs = require('node:fs');
import path = require('node:path');

import { APP_PATHS, PROJECT_SYSTEM_PROMPT_PATH, PYTHON_COMMAND } from './config.js';
import { planSkills, type ResolvedSessionPlan } from './session-assembly.js';

function moduleResourceGuide(plan: ResolvedSessionPlan | null) {
  if (!plan) return '- 未解析 Module 会话计划；不能假定任何外部 Skill 或资产可用。';
  const resolvedSkills = planSkills(plan);
  const skills = resolvedSkills.length
    ? resolvedSkills.map((skillPath) => `- Skill 根目录：\`${path.dirname(skillPath)}\`（入口：\`${skillPath}\`；脚本和参考文件均相对此目录）`).join('\n')
    : '- 本会话没有加载 Skill。';
  const assets = plan.assets.length
    ? plan.assets.map((asset) => {
      const environment = asset.kind === 'knowledge'
        ? '；运行时目录映射：`TRANSPORTX_KNOWLEDGE_ASSETS_JSON`'
        : asset.kind === 'data'
          ? '；运行时目录映射：`TRANSPORTX_DATA_ASSETS_JSON`'
          : '';
      return `- ${asset.kind} 资产 \`${asset.id}\`：\`${asset.path}\`${environment}`;
    }).join('\n')
    : '- 本会话没有选中的 Data、Knowledge 或 Template 资产。';
  return `### 已加载 Skill\n${skills}\n\n### 已选资产\n${assets}`;
}

const PROJECT_PROMPT_PLACEHOLDERS: Record<string, (cwd: string, plan: ResolvedSessionPlan | null) => string> = {
  PROJECT_ROOT: () => APP_PATHS.appRoot,
  TASK_WORKING_DIRECTORY: (cwd) => cwd,
  PYTHON_COMMAND: () => PYTHON_COMMAND,
  KNOWLEDGE_ROOT: (_cwd, plan) => plan?.assets.filter((asset) => asset.kind === 'knowledge').map((asset) => `${asset.id}=${asset.path}`).join('\n') || '<not installed>',
  DATA_ROOT: (_cwd, plan) => plan?.assets.filter((asset) => asset.kind === 'data').map((asset) => `${asset.id}=${asset.path}`).join('\n') || '<not installed>',
  MODULE_RESOURCE_GUIDE: (_cwd, plan) => moduleResourceGuide(plan),
};

export function renderProjectPrompt(template: string, cwd: string, plan: ResolvedSessionPlan | null = null) {
  let rendered = template;
  for (const [name, resolveValue] of Object.entries(PROJECT_PROMPT_PLACEHOLDERS)) {
    rendered = rendered.replaceAll(`{{${name}}}`, resolveValue(cwd, plan));
  }
  const unresolved = Array.from(new Set(rendered.match(/\{\{[A-Z0-9_]+\}\}/g) || []));
  if (unresolved.length) throw new Error(`Unknown project prompt placeholders: ${unresolved.join(', ')}`);
  return rendered.trim();
}

export function loadProjectPrompt(cwd: string, promptPath: string | undefined, plan: ResolvedSessionPlan | null = null) {
  if (!promptPath) throw new Error('Resolved session plan has no domain prompt.');
  if (!fs.existsSync(promptPath)) throw new Error(`Project prompt not found: ${promptPath}`);
  return renderProjectPrompt(fs.readFileSync(promptPath, 'utf8'), cwd, plan);
}

export function loadSystemPrompt() {
  if (!fs.existsSync(PROJECT_SYSTEM_PROMPT_PATH)) throw new Error(`System prompt not found: ${PROJECT_SYSTEM_PROMPT_PATH}`);
  const prompt = fs.readFileSync(PROJECT_SYSTEM_PROMPT_PATH, 'utf8').trim();
  if (!prompt) throw new Error(`System prompt is empty: ${PROJECT_SYSTEM_PROMPT_PATH}`);
  return prompt;
}
