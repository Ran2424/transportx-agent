export function sessionFileUrl(sessionId: string, filePath: string, download = false) {
  return `/api/file/raw?${new URLSearchParams({ sessionId, path: filePath, ...(download ? { download: '1' } : {}) })}`;
}

export function withDownload(url: string) {
  const target = new URL(url, window.location.origin);
  target.searchParams.set('download', '1');
  return `${target.pathname}${target.search}`;
}
