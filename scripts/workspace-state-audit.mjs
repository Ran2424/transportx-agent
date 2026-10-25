// T3 source inventory and read-only sampling. Reports omit conversation text and URL credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const repo = process.cwd();
const report = { at: new Date().toISOString(), baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sources: [], histories: [], unavailableRoots: [], discoveredHistories: 0 };
const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isSymbolicLink() ? [] : entry.isDirectory() ? walk(path.join(directory, entry.name)) : /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
for (const file of ['src', 'desktop', 'scripts', 'modules/capabilities', 'modules/official'].flatMap(walk)) {
  const source = fs.readFileSync(file, 'utf8');
  const endpoints = [], state = [], dependencies = [];
  source.split('\n').forEach((line, index) => {
    if (/\/api\//.test(line.replaceAll('\\/', '/'))) endpoints.push({ line: index + 1, source: line.trim() });
    if (/\.tau|resolved-session-plan|attachments\.json|canvas-contexts|geo-interactions|timing-metrics|migrateStoredCitations|acquireWriteLease|sessionFile|sessionId|PiRpcSession|conversationId|workspaceId/.test(line)) state.push(index + 1);
    for (const match of line.matchAll(/(?:from\s+|import\s*\(|require\s*\()['"]([^'"]+)/g)) dependencies.push(match[1]);
  });
  if (endpoints.length || state.length) report.sources.push({ file: path.relative(repo, file).replaceAll('\\', '/'), sha256: digest(source), endpoints, stateLines: state, dependencies: [...new Set(dependencies)] });
}
const roots = [...new Set([process.env.PI_CODING_AGENT_SESSION_DIR, path.join(os.homedir(), '.transportx/traffic-agent/sessions'), path.join(os.homedir(), '.pi/agent/sessions')].filter(Boolean))];
const candidates = [];
for (const [rootIndex, root] of roots.entries()) {
  if (!fs.existsSync(root)) { report.unavailableRoots.push(rootIndex); continue; }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const files = entry.isDirectory() ? fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.jsonl')).map((item) => path.join(root, entry.name, item.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [path.join(root, entry.name)] : [];
    for (const file of files) { const stat = fs.statSync(file); if (stat.size <= 16 * 1024 * 1024) candidates.push({ file, root, rootIndex, modified: stat.mtimeMs, size: stat.size }); }
  }
}
// Include older samples as well as recent ones; no writes to any source history.
candidates.sort((left, right) => right.modified - left.modified);
const selected = [...new Set([...candidates.slice(0, 30), ...candidates.slice(-10)])];
report.discoveredHistories = candidates.length;
const families = {
  attachment: /attachmentIds|\[Attachment|attachments\//,
  markdown: /!\[[^\]]*\]\(|\[[^\]]+\]\([^)]*\.(?:pdf|docx|xlsx|png|jpg)/,
  video: /tau-video|video-resources|video_probe|video_process/,
  document: /"format":"(?:pdf|docx|xlsx|pptx)"|document:auto|document\.open/,
};
report.targetedFamilies = Object.fromEntries(Object.keys(families).map((name) => [name, 0]));
for (const candidate of candidates) {
  if (Object.values(report.targetedFamilies).every((count) => count >= 3)) break;
  const descriptor = fs.openSync(candidate.file, 'r');
  let tail;
  try { const buffer = Buffer.alloc(Math.min(candidate.size, 128 * 1024)); const count = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, candidate.size - buffer.length)); tail = buffer.subarray(0, count).toString('utf8'); }
  finally { fs.closeSync(descriptor); }
  for (const [name, pattern] of Object.entries(families)) {
    if (report.targetedFamilies[name] >= 3 || !pattern.test(tail)) continue;
    report.targetedFamilies[name]++; if (!selected.includes(candidate)) selected.push(candidate);
  }
}
for (const { file, root, rootIndex, size } of selected) {
  const before = fs.readFileSync(file);
  const urls = new Map(), categories = new Set();
  let malformed = 0, entries = 0, validHeader = false;
  const visit = (value, field = '') => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/(?:https?:\/\/[^\s"'<>)]*)?\/api\/[A-Za-z0-9_./?=&%:+-]+/g)) {
        const raw = match[0];
        // Store only route shape and parameter names, never path values, live IDs or tokens.
        const parsed = new URL(raw, 'http://local.invalid');
        const route = parsed.pathname.replace(/\/(?:tau_[^/]+|[a-f0-9]{8}-[a-f0-9-]{27,}|(?:geo|video|att|ctx|spatial|cad)_[^/]+)/gi, '/:id');
        const addressKind = raw.startsWith('/') ? 'relative' : ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ? 'loopback' : 'external';
        const key = JSON.stringify({ route, addressKind, parameters: [...new Set(parsed.searchParams.keys())].sort(), field });
        urls.set(key, (urls.get(key) || 0) + 1);
      }
      if (/attachment|canvas|geo|video|document|citation/i.test(field)) categories.add(field);
      if (['toolName', 'kind', 'customType'].includes(field) && /^(?:cad_|tau_(?:spatial|video|geo)|pi-canvas|tau-geo|tau-video|pi-web-bridge)/.test(value)) categories.add(`${field}:${value}`);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, field));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (/attachment|canvas|geo|video|document|citation/i.test(key)) categories.add(key); visit(item, key); }
  };
  for (const [index, line] of before.toString('utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); entries++; if (index === 0) validHeader = value.type === 'session' && typeof value.id === 'string' && typeof value.cwd === 'string'; visit(value); } catch { malformed++; }
  }
  const after = fs.readFileSync(file);
  report.histories.push({ rootIndex, historyKeySha256: digest(path.relative(root, file)), sha256: digest(before), bytes: size, entries, malformed, validHeader, unchanged: before.equals(after), categories: [...categories].sort(), persistentUrls: [...urls].map(([shape, count]) => ({ ...JSON.parse(shape), count })) });
}
const output = path.resolve(process.env.TRANSPORTX_WORKSPACE_AUDIT_REPORT || '.plans/workspace-conversations/state-audit.json');
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, sourceFiles: report.sources.length, endpointLines: report.sources.reduce((count, item) => count + item.endpoints.length, 0), sampledHistories: report.histories.length, withPersistentUrls: report.histories.filter((item) => item.persistentUrls.length).length, sourceBytesUnchanged: report.histories.every((item) => item.unchanged) }));
