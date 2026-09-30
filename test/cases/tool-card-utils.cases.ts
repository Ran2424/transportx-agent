const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

caseTest('classifies Tool Card icons and resolves supplied file paths', async () => {
  const { compactCharacterCount, toolFileName, toolFilePath, toolIconName } = await import('../../src/web/platform/conversation/tool-card-utils.ts');
  assert.equal(toolIconName('present_visualization'), 'map');
  assert.equal(toolIconName('read_csv'), 'file');
  assert.equal(toolIconName('apply-patch'), 'write');
  assert.equal(toolFilePath({ sourceInfo: { path: 'reports/result.md' } }), 'reports/result.md');
  assert.equal(toolFileName('reports\\result.md'), 'result.md');
  assert.equal(compactCharacterCount(12_345), '12k');
});
