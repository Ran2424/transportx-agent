const WEBSITE_URL = 'https://transportxlab.com/application/transportx-agent/';
const DOWNLOAD_ORIGIN = 'https://download.transkgllm.com';

export function compareReleaseVersions(left: string, right: string) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function websiteReleaseVersion(html: string, installerPattern: string): string | undefined {
  const installer = new RegExp(installerPattern);
  let latest: string | undefined;
  for (const link of html.matchAll(/<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    let url: URL, pathname: string;
    try { url = new URL(link[1] ?? link[2] ?? link[3], WEBSITE_URL); pathname = decodeURIComponent(url.pathname); }
    catch { continue; }
    if (url.origin !== DOWNLOAD_ORIGIN) continue;
    const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    const version = installer.exec(filename)?.[1];
    if (!version || pathname !== `/releases/v${version}/${filename}`) continue;
    if (!latest || compareReleaseVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

export async function readWebsiteRelease(installerPattern: string): Promise<string | undefined> {
  const response = await fetch(WEBSITE_URL, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Website release check failed');
  return websiteReleaseVersion(await response.text(), installerPattern);
}
