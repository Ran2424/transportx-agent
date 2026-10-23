import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'node_modules', '@mlightcad', 'cad-simple-viewer', 'dist', 'mtext-renderer-worker.js');
const targetDirectory = path.join(root, 'src', 'web', 'public', 'workers');
const target = path.join(targetDirectory, 'mtext-renderer-worker.js');

if (!fs.existsSync(source)) {
  throw new Error(`CAD MTEXT worker is missing: ${source}`);
}
fs.mkdirSync(targetDirectory, { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied CAD MTEXT worker to ${path.relative(root, target)}`);
