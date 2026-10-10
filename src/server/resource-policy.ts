/** Shared HTTP policy for active content in workspace and citation files. */
export function resourceSecurityHeaders(mime: string): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    ...(mime === 'image/svg+xml' || mime.startsWith('text/html') ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
  };
}
