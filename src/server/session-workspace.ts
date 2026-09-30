const fs = require('node:fs');
const path = require('node:path');

import { APP_PATHS, TAU_SETTINGS, expandHome } from './config.js';

export function makeSessionId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function timestampForDirectory(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function safeDirectoryName(name: unknown) {
  const cleaned = String(name || 'untitled')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+$/, 'untitled')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'untitled';
}

export function createSessionWorkingDirectory(parentCwd?: string, sessionName?: string | null) {
  const explicitParent = Boolean(parentCwd);
  const parent = path.resolve(expandHome(parentCwd || TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir));
  if (explicitParent) {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error(`Directory not found: ${parent}`);
    }
  } else {
    fs.mkdirSync(parent, { recursive: true });
  }

  const timestamp = timestampForDirectory();
  const prefix = sessionName ? `${timestamp}-${safeDirectoryName(sessionName)}` : timestamp;
  for (let i = 1; i <= 999; i++) {
    const name = i === 1 ? prefix : `${prefix}-${i}`;
    const candidate = path.join(parent, name);
    if (fs.existsSync(candidate)) continue;
    fs.mkdirSync(candidate);
    return candidate;
  }

  throw new Error(`Cannot create unique task directory in ${parent}`);
}
