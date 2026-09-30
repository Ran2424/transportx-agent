const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

caseTest('Tool-result truncation text follows the requested locale', async () => {
  const { formatToolResultText } = await import('../../src/public/tool-result.ts');
  const result = { content: [{ type: 'text', text: 'word!'.repeat(10_020) }] };

  assert.match(formatToolResultText(result, 'en-US'), /Tool output was too long and has been truncated: 50,100 characters/);
  assert.match(formatToolResultText(result, 'zh-CN'), /工具输出过长，已截断 50,100 字符/);
});
