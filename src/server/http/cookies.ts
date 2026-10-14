// Manual parser because the WebSocket upgrade path has no framework.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch {}
  }
  return out;
}

