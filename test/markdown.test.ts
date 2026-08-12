const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Message Markdown preserves paragraphs and renders pasted tables and lists', async () => {
  const { renderUserMarkdown } = await import('../src/public/markdown.ts');
  const html = renderUserMarkdown('请回答以下问题：\n\n| 题号 | 问题 |\n| --- | --- |\n| 6 | 客流最高的是哪一站？ |\n\n- 第一项\n- 第二项\n\n下一题。');
  assert.match(html, /<p>请回答以下问题：<\/p>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td style="text-align:left">客流最高的是哪一站？<\/td>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<p>下一题。<\/p>/);
});

test('Citation accessibility text follows the requested locale', async () => {
  const { renderMarkdown } = await import('../src/public/markdown.ts');
  const english = renderMarkdown('Known [[cite:known]] and missing [[cite:missing]].', { known: 1 }, undefined, 'en-US');
  const chinese = renderMarkdown('已有 [[cite:known]]，缺失 [[cite:missing]]。', { known: 1 }, undefined, 'zh-CN');

  assert.match(english, /aria-label="View citation 1"/);
  assert.match(english, />Citation unavailable<\/span>/);
  assert.match(chinese, /aria-label="查看引用 1"/);
  assert.match(chinese, />引用不可用<\/span>/);
});
