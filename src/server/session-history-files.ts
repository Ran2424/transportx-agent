import fs from 'node:fs';
import path from 'node:path';
import { containedFile } from './util/resource-path.js';

export function listSessionHistoryFiles(sessionsDir: string) {
  if (!fs.existsSync(sessionsDir)) return [];
  const files: Array<{ dirName: string; file: string; filePath: string }> = [];
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ dirName: '', file: entry.name, filePath: path.join(sessionsDir, entry.name) });
    else if (entry.isDirectory()) {
      const projectDir = path.join(sessionsDir, entry.name);
      for (const file of fs.readdirSync(projectDir).filter((name: string) => name.endsWith('.jsonl'))) files.push({ dirName: entry.name, file, filePath: path.join(projectDir, file) });
    }
  }
  return files.filter(({ filePath }) => { try { containedFile(sessionsDir, filePath); return true; } catch { return false; } });
}
