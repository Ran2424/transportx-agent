export function sessionFileUrl(sessionId: string, filePath: string, download = false) {
  return `/api/conversations/${encodeURIComponent(sessionId)}/files/raw?${new URLSearchParams({ path: filePath, ...(download ? { download: '1' } : {}) })}`;
}

export function withDownload(url: string) {
  const target = new URL(url, window.location.origin);
  target.searchParams.set('download', '1');
  return `${target.pathname}${target.search}`;
}
