// Pre-flight check for desktop installers. Looks up the platform profile and
// enforces its signing requirements. Throws when a release-blocking condition
// is unmet unless the explicit allow-unsigned escape hatch is set.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { builderPlatformFor, getPlatformProfile } from './platform-profile.mjs';

function run() {
  const allowUnsigned = process.argv.includes('--allow-unsigned') || process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD === '1';

  let profile;
  try {
    profile = getPlatformProfile(builderPlatformFor(process.platform));
  } catch (error) {
    throw new Error(`No desktop release profile registered for ${process.platform}. Update desktop/scripts/platform-profile.mjs to add one.`);
  }

  // Native host arch must align with the supported release arch. A mac arm64
  // release cannot run on an Intel host because the bundled Python is not portable.
  if (profile.signing.hostArchRequired && process.arch !== profile.signing.hostArchRequired) {
    throw new Error(`${profile.label} release must run on a ${profile.signing.hostArchRequired} Node runtime, got ${process.arch}`);
  }

  const hasAny = (...names) => names.some((name) => Boolean(process.env[name]));

  if (allowUnsigned) {
    console.warn(`[check-desktop-release] allow-unsigned bypassed: ${profile.signing.allowUnsignedPurpose}`);
    if (profile.key === 'darwin') {
      const identityProbe = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
      if ((identityProbe.status ?? 1) !== 0 || !identityProbe.stdout?.includes('Developer ID Application')) {
        // Not fatal for `--allow-unsigned`; the after-pack step falls back to an
        // ad-hoc signature (`--sign -`).
        console.warn('[check-desktop-release] no Developer ID in keychain; ad-hoc signature will be applied after pack.');
      }
    }
    return;
  }

  if (profile.key === 'darwin') {
    const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout || '';
    const hasSigningIdentity = hasAny('CSC_LINK', 'CSC_NAME') || identities.includes('Developer ID Application');
    if (!hasSigningIdentity) {
      throw new Error(`${profile.signing.description} (keychain also has no Developer ID Application identity). Configure CSC_LINK/CSC_NAME or install the Developer ID certificate.`);
    }
    const hasAppleId = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
    const hasApiKey = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER && process.env.APPLE_TEAM_ID);
    const hasKeychainProfile = Boolean(process.env.APPLE_KEYCHAIN_PROFILE && process.env.APPLE_TEAM_ID);
    if (!hasAppleId && !hasApiKey && !hasKeychainProfile) {
      throw new Error('macOS release requires notarization credentials. Configure Apple ID (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID), App Store Connect API key (APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER + APPLE_TEAM_ID), or an Apple keychain profile (APPLE_KEYCHAIN_PROFILE + APPLE_TEAM_ID).');
    }
    return;
  }

  if (profile.key === 'win') {
    const hasCertificate = hasAny('WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_NAME', 'CSC_NAME');
    if (!hasCertificate) {
      throw new Error(`${profile.signing.description} Configure WIN_CSC_LINK/WIN_CSC_NAME or the CSC_* fallback; use TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 only for internal structure verification.`);
    }
    return;
  }

  throw new Error(`No signing check is defined for platform profile ${profile.key}.`);
}

try {
  run();
} catch (error) {
  console.error(`[check-desktop-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
