import { test as nodeTest, type TestContext } from 'node:test';

type TestCallback = (context: TestContext) => unknown | Promise<unknown>;
type Hook = (...args: any[]) => unknown;
type SuiteCase = { name: string; options: Record<string, unknown>; callback: TestCallback };

const cases: SuiteCase[] = [];
const beforeHooks: Hook[] = [];
const afterHooks: Hook[] = [];
const beforeEachHooks: Hook[] = [];

export function suiteCase(name: string, ...args: unknown[]) {
  const callback = args.find((item): item is TestCallback => typeof item === 'function');
  if (!callback) throw new Error(`Test case has no callback: ${name}`);
  const options = args.find((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)) || {};
  cases.push({ name, options, callback });
}

export function suiteBefore(hook: Hook) { beforeHooks.push(hook); }
export function suiteAfter(hook: Hook) { afterHooks.push(hook); }
export function suiteBeforeEach(hook: Hook) { beforeEachHooks.push(hook); }

function invokeHook(hook: Hook, context: TestContext) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      const result = hook.length >= 2 ? hook(context, done) : hook(context);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(() => done(), done);
      } else if (hook.length < 2) {
        done();
      }
    } catch (error) {
      done(error);
    }
  });
}

function caseContext(context: TestContext, cleanups: Array<() => unknown>) {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'after') return (hook: () => unknown) => { cleanups.push(hook); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runCase(item: SuiteCase, context: TestContext, failures: Error[]) {
  if (item.options.skip || item.options.todo) return;
  const cleanups: Array<() => unknown> = [];
  try {
    for (const hook of beforeEachHooks) await invokeHook(hook, context);
    await item.callback(caseContext(context, cleanups));
  } catch (error) {
    failures.push(error instanceof Error ? new Error(`${item.name}: ${error.message}`, { cause: error }) : new Error(`${item.name}: ${String(error)}`));
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { failures.push(error instanceof Error ? new Error(`${item.name} cleanup: ${error.message}`, { cause: error }) : new Error(`${item.name} cleanup: ${String(error)}`)); }
    }
  }
}

export function registerSuite(name: string) {
  nodeTest(name, async (context) => {
    const failures: Error[] = [];
    try {
      for (const hook of beforeHooks) await invokeHook(hook, context);
      for (const item of cases) await runCase(item, context, failures);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      for (const hook of afterHooks) {
        try { await invokeHook(hook, context); }
        catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      }
    }
    if (failures.length) throw new AggregateError(failures, `${failures.length} case(s) failed in ${name}`);
  });
}
