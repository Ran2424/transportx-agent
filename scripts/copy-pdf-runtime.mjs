import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'node_modules', 'pdfjs-dist');
const target = path.join(root, 'src', 'web', 'public', 'pdfjs');
fs.mkdirSync(target, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  fs.cpSync(path.join(source, directory), path.join(target, directory), { recursive: true });
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
