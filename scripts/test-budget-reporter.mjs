import { spec } from 'node:test/reporters';
import { Readable } from 'node:stream';
import { MAX_TESTS } from './check-test-budget.mjs';

export default async function* reportWithBudget(source) {
  let count = 0;
  async function* countResults() {
    for await (const event of source) {
      if (event.type === 'test:pass' || event.type === 'test:fail') count++;
      yield event;
    }
  }
  yield* Readable.from(countResults()).pipe(new spec());
  if (count > MAX_TESTS) {
    process.exitCode = 1;
    yield `Test budget exceeded at runtime: ${count}/${MAX_TESTS} total tests.\n`;
  } else {
    yield `Test runtime budget: ${count}/${MAX_TESTS} total tests (including skipped, todo and nested tests).\n`;
  }
}
