const assert = require('node:assert/strict');
const { test } = require('node:test');

test('tool text remains complete through 50,000 characters and truncates after that boundary', async () => {
  const { formatToolResultText } = await import('../src/public/tool-result.ts');
  const exact = '文'.repeat(50_000);
  const over = '字'.repeat(50_001);

  assert.equal(formatToolResultText({ content: [{ type: 'text', text: exact }] }), exact);

  const truncated = formatToolResultText({ content: [{ type: 'text', text: over }] });
  assert.equal(truncated.slice(0, 50_000), '字'.repeat(50_000));
  assert.match(truncated, /\[工具输出过长，已截断 50,001 字符\]$/);
});

test('large encoded image payloads remain omitted from tool text', async () => {
  const { formatToolResultText } = await import('../src/public/tool-result.ts');
  const output = formatToolResultText({ content: [{ type: 'text', text: `data:image/png;base64,${'a'.repeat(60_000)}` }] });

  assert.match(output, /^\[图片\/二进制内容已省略：60,022 字符\]$/);
});
