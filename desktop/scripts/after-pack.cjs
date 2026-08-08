const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD !== '1') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  run('codesign', [
    '--force',
    '--deep',
    '--strict',
    '--sign', '-',
    '--timestamp=none',
    appPath,
  ]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log(`Applied verified ad-hoc signature to ${appPath}`);
};
