const { test } = require('node:test') as typeof import('node:test');

test('Context usage retains compaction estimates separately from accumulated token usage', async () => {
  const assert = require('node:assert/strict');
  const { contextUsageAfterCompaction, mergeContextUsage, withUsageTotals } = require('../../bin/session-context-usage.js');

  // updates context usage from Pi and retains usage totals separately
  {
    const contextUsage = mergeContextUsage(null, { tokens: 9164, contextWindow: 128000, percent: 7.159375 });
    assert.deepEqual(
      withUsageTotals(contextUsage, { input: 2659, output: 361, total: 9164 }),
      { tokens: 9164, contextWindow: 128000, percent: 7.159375, usage: { input: 2659, output: 361, total: 9164 } },
    );
  }

  // applies a compaction estimate against the current or model context window
  {
    assert.deepEqual(
      contextUsageAfterCompaction(null, 100000, 23000),
      { tokens: 23000, contextWindow: 100000, percent: 23 },
    );
    assert.equal(contextUsageAfterCompaction(null, 0, 23000), null);
  }
});
