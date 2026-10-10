/** Bounded safe diagnostics. Never pass upstream messages or payload text. */
export function boundedDiagnostics(limit = 20) {
  let emitted = 0;
  const seen = new Set<string>();
  return (code: string, fields: { sessionId?: string; commandId?: string; jobId?: string; bytes?: number; count?: number } = {}) => {
    const key = `${code}:${fields.sessionId || ''}:${fields.commandId || ''}:${fields.jobId || ''}`;
    if (emitted >= limit || seen.has(key)) return;
    seen.add(key);
    emitted++;
    console.warn('[TransportX diagnostic]', { code, ...fields });
  };
}
