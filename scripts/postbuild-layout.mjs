import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (target !== 'server' && target !== 'public') {
  throw new Error('Usage: node scripts/postbuild-layout.mjs <server|public>');
}

const root = process.cwd();
const outputRoot = path.join(root, target === 'server' ? 'bin' : 'public');
const nestedRoot = path.join(outputRoot, target === 'server' ? 'server' : 'public');

function rewriteContractImports(filePath) {
  if (!filePath.endsWith('.js')) return;
  const original = fs.readFileSync(filePath, 'utf8');
  const rewritten = target === 'server'
    ? original.replaceAll('../contracts/', './contracts/')
    : original.replace(/((?:\.\.\/)+)contracts\//g, (_match, prefix) => {
      const reduced = prefix.slice(3);
      return `${reduced || './'}contracts/`;
    });
  if (rewritten !== original) fs.writeFileSync(filePath, rewritten);
}

function moveTree(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      moveTree(sourcePath, destinationPath);
      fs.rmSync(sourcePath, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.rmSync(destinationPath, { force: true });
    fs.renameSync(sourcePath, destinationPath);
    rewriteContractImports(destinationPath);
  }
}

moveTree(nestedRoot, outputRoot);
fs.rmSync(nestedRoot, { recursive: true, force: true });
