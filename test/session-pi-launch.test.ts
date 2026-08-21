const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSessionPiLaunch } = require('../bin/session-pi-launch.js');

test('builds Pi startup arguments and session-scoped asset environment', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-pi-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension.ts');
  const skill = path.join(root, 'SKILL.md');
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(extension, 'export {};\n');
  fs.writeFileSync(skill, '# Skill\n');
  fs.writeFileSync(prompt, '工作目录：{{TASK_WORKING_DIRECTORY}}\n');
  const plan = {
    modules: [{ entrypoints: [
      { kind: 'extension', path: extension },
      { kind: 'skill', path: skill },
      { kind: 'prompt', path: prompt },
    ] }],
    assets: [
      { id: 'data:roads', kind: 'data', path: '/assets/roads' },
      { id: 'knowledge:rules', kind: 'knowledge', path: '/assets/rules' },
    ],
  };
  const launch = buildSessionPiLaunch({
    cwd: root,
    sessionId: 'tau_1',
    sessionFile: '/tmp/history.jsonl',
    modelSpec: 'openai/gpt-5',
    resolvedSessionPlan: plan,
    serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token' },
    endpoints: { citation: 'http://127.0.0.1:3000', spatial: 'http://127.0.0.1:3001', video: 'http://127.0.0.1:3002' },
  });

  assert.deepEqual(launch.args.slice(-10), [
    '--extension', extension,
    '--skill', skill,
    '--append-system-prompt', `工作目录：${root}`,
    '--session', '/tmp/history.jsonl',
    '--model', 'openai/gpt-5',
  ]);
  assert.equal(launch.env.TAU_VIDEO_TOKEN, 'video-token');
  assert.deepEqual(JSON.parse(launch.env.TRANSPORTX_DATA_ASSETS_JSON), { 'data:roads': '/assets/roads' });
  assert.deepEqual(JSON.parse(launch.env.TRANSPORTX_KNOWLEDGE_ASSETS_JSON), { 'knowledge:rules': '/assets/rules' });
});
