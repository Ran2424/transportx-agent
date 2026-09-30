const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

caseTest('interaction extension exposes tau_ask_user and accepts a custom select answer', async () => {
  const userInteractionExtension = require('../../modules/capabilities/interaction/extensions/pi-user-interaction/index.ts').default;
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  userInteractionExtension(pi as any);

  assert.deepEqual([...tools.keys()], ['tau_ask_user']);
  const result = await tools.get('tau_ask_user').execute('call-custom-answer', {
    kind: 'select',
    title: '选择分析日期',
    message: '请选择预设范围或输入其他范围',
    options: [
      { value: 'weekday', label: '只看工作日' },
      { value: 'weekend', label: '包含周末' },
    ],
  }, undefined, undefined, {
    hasUI: true,
    ui: { select: async () => '仅分析节假日' },
  });

  assert.equal(result.details.status, 'answered');
  assert.equal(result.details.value, '仅分析节假日');
  assert.equal(result.content[0].text, '用户回答：仅分析节假日');
});
