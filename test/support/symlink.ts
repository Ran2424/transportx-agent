import fs from 'node:fs';
import type { TestContext } from 'node:test';

export async function testSymlink(context: TestContext, name: string, target: string, link: string, verify: () => unknown, type?: 'dir' | 'file') {
  try { fs.symlinkSync(target, link, type); }
  catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) throw cause;
    context.diagnostic(`${name}: not checked; host cannot create symbolic links (${code})`);
    return;
  }
  try { await verify(); }
  finally { fs.unlinkSync(link); }
}
