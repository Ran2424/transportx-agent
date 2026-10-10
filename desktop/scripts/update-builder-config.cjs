const fs = require('node:fs');
const path = require('node:path');

module.exports = async function updateBuilderConfig() {
  const { getPlatformProfile } = await import('./platform-profile.mjs');
  const profile = getPlatformProfile();
  const root = path.resolve(__dirname, '../..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((value) => value.startsWith(`${version} - `)) || sections.find((value) => value.startsWith('Unreleased\n'));
  if (!section) throw new Error(`No release notes for ${version}`);
  return {
    [profile.builderPlatform]: {
      artifactName: profile.update.artifactName,
      publish: { provider: 'generic', url: profile.update.url },
    },
    releaseInfo: { releaseNotes: section.slice(section.indexOf('\n') + 1).trim() },
  };
};
