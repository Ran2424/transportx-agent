import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const fromRoot = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'desktop', 'modules', 'scripts', 'test'], { encoding: 'utf8' });
const files = [...new Set(tracked.split('\0'))].filter((file) => /\.(?:[cm]?tsx?|[cm]?js|css|py)$/.test(file) && fs.existsSync(file)).sort();
const sourceFiles = new Set(files);
const graph = new Map();
const lines = {};
const reverse = [];
const rootLayer = (file) => {
  const [root, layer] = file.split('/');
  return root === 'src' ? layer : root;
};
const allowed = {
  contracts: ['contracts'],
  public: ['contracts', 'public'],
  web: ['contracts', 'public', 'web'],
  server: ['contracts', 'server'],
  desktop: ['contracts', 'desktop'],
};

function resolveLocal(from, specifier) {
  if (!specifier.startsWith('.')) return;
  const target = fromRoot(path.resolve(path.dirname(from), specifier));
  const stem = target.replace(/\.[cm]?js$/, '');
  return [target, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].map(ext => stem + ext), target + '/index.ts', target + '/index.tsx']
    .find(candidate => sourceFiles.has(candidate));
}

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const count = content.replace(/\r?\n$/, '').split(/\r?\n/).length;
  if (count > 500) lines[file] = count;
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const edges = new Set();
  graph.set(file, edges);
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const inspect = (node) => {
    const value = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        ? node.argument.literal
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
          ? node.arguments[0] : undefined;
    const target = value && ts.isStringLiteralLike(value) && resolveLocal(file, value.text);
    if (target) {
      edges.add(target);
      const layer = rootLayer(file);
      if (allowed[layer] && !allowed[layer].includes(rootLayer(target))) reverse.push(file + ' -> ' + target);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
}

// Report each edge inside a strongly connected component.
const cycles = [];
const visited = new Map(), open = new Set(), stack = [];
let position = 0;
function visit(file) {
  const order = position++;
  visited.set(file, { order, low: order });
  open.add(file);
  stack.push(file);
  const entry = visited.get(file);
  for (const target of graph.get(file) ?? []) {
    if (!visited.has(target)) { visit(target); entry.low = Math.min(entry.low, visited.get(target).low); }
    else if (open.has(target)) entry.low = Math.min(entry.low, visited.get(target).order);
  }
  if (entry.low !== order) return;
  const group = new Set();
  do { const item = stack.pop(); open.delete(item); group.add(item); } while (!group.has(file));
  for (const item of group) for (const target of graph.get(item) ?? []) if (group.has(target)) cycles.push(item + ' -> ' + target);
}
for (const file of graph.keys()) if (!visited.has(file)) visit(file);

const current = { lines, reverse: [...new Set(reverse)].sort(), cycles: cycles.sort() };
if (process.argv.includes('--report')) {
  console.log(JSON.stringify(current, null, 2));
} else {
  const errors = [
    ...Object.entries(current.lines).map(([file, count]) => `${file}: ${count} lines (limit 500)`),
    ...current.reverse.map(edge => `reverse: ${edge}`),
    ...current.cycles.map(edge => `cycle: ${edge}`),
  ];
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Architecture checked: ${files.length} files, 0 line violations, 0 reverse edges, 0 cycle edges.`);
}
