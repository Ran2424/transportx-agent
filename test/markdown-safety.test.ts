const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Markdown rendering escapes raw HTML and refuses unsafe resource URLs', async () => {
  const { renderMarkdown } = await import('../src/public/markdown.ts');
  const html = renderMarkdown('<script>alert(1)</script> [bad](javascript:alert(1)) ![bad](javascript:alert(1)) [safe](https://example.com/a?x=1)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="javascript:/i);
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1"/);
});
