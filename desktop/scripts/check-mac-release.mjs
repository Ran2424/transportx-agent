import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform === 'darwin' && process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD !== '1') {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout || '';
  const hasSigningIdentity = Boolean(process.env.CSC_LINK || process.env.CSC_NAME || identities.includes('Developer ID Application'));
  if (!hasSigningIdentity) {
    throw new Error('macOS release requires a Developer ID Application certificate. Configure CSC_LINK/CSC_KEY_PASSWORD or install the certificate in Keychain.');
  }

  const hasAppleId = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  const hasApiKey = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER && process.env.APPLE_TEAM_ID);
  const hasKeychainProfile = Boolean(process.env.APPLE_KEYCHAIN_PROFILE && process.env.APPLE_TEAM_ID);
  if (!hasAppleId && !hasApiKey && !hasKeychainProfile) {
    throw new Error('macOS release requires notarization credentials. Configure Apple ID, App Store Connect API key, or an Apple keychain profile.');
  }
}
