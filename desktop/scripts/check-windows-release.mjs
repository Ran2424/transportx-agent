import process from 'node:process';

const allowUnsigned = process.argv.includes('--allow-unsigned') || process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD === '1';

if (process.platform !== 'win32') {
  throw new Error('Windows installers must be built on a native Windows x64 host so bundled Python, ffmpeg and NSIS can be executed before release.');
}

if (!allowUnsigned) {
  const hasCertificate = Boolean(
    process.env.WIN_CSC_LINK
    || process.env.CSC_LINK
    || process.env.WIN_CSC_NAME
    || process.env.CSC_NAME,
  );
  if (!hasCertificate) {
    throw new Error('Windows release requires an Authenticode certificate. Configure WIN_CSC_LINK/CSC_LINK or WIN_CSC_NAME/CSC_NAME; use TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 only for internal test builds.');
  }
}

if (process.arch !== 'x64') throw new Error(`Windows release must run on an x64 Node runtime, got ${process.arch}`);
