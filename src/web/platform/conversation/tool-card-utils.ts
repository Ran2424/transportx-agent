export function toolIconName(name: string) {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  if (['bash', 'shell', 'command', 'exec'].some((value) => normalized === value || normalized.startsWith(`${value}_`))) return 'command';
  if (normalized.includes('task')) return 'task';
  if (normalized.includes('geo') || normalized.includes('map') || normalized.includes('visualization')) return 'map';
  if (normalized === 'read' || normalized.startsWith('read_')) return 'file';
  if (['write', 'edit', 'create', 'apply_patch'].some((value) => normalized === value || normalized.startsWith(`${value}_`))) return 'write';
  return 'tool';
}

export function toolFilePath(args: Record<string, unknown>) {
  for (const key of ['path', 'filePath', 'file_path']) {
    if (typeof args[key] === 'string' && args[key]) return args[key];
  }
  const sourceInfo = args.sourceInfo;
  if (sourceInfo && typeof sourceInfo === 'object' && !Array.isArray(sourceInfo) && typeof (sourceInfo as Record<string, unknown>).path === 'string') return (sourceInfo as Record<string, unknown>).path as string;
  return '';
}

export function toolFileName(path: string) {
  return path.replaceAll('\\', '/').split('/').pop() || path;
}

export function compactCharacterCount(count: number) {
  return count < 1_000 ? String(count) : `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
}
