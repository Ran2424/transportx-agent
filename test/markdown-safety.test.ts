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

test('Markdown renders registered citations but preserves markers inside code', async () => {
  const { renderMarkdown } = await import('../src/public/markdown.ts');
  const html = renderMarkdown('结论。[[cite:K-DOC-000001]]\n\n`[[cite:K-CODE-000002]]`\n\n```\n[[cite:K-BLOCK-000003]]\n```', {
    'K-DOC-000001': 1,
    'K-CODE-000002': 2,
    'K-BLOCK-000003': 3,
  });
  assert.match(html, /data-citation-id="K-DOC-000001"/);
  assert.match(html, /<code>\[\[cite:K-CODE-000002\]\]<\/code>/);
  assert.match(html, /<pre><code>\[\[cite:K-BLOCK-000003\]\]/);
  assert.doesNotMatch(html, /data-citation-id="K-CODE-000002"/);
  assert.doesNotMatch(html, /data-citation-id="K-BLOCK-000003"/);
});
