// Pi remains the runtime. Pin this small loader fix until upstream can skip
// package discovery when every automatically discovered resource is disabled.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url);
const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
if (version !== '0.80.10') throw new Error('Re-audit the Pi resource discovery patch before upgrading Pi');
const file = fileURLToPath(new URL('dist/core/resource-loader.js', root));
const before = 'const resolvedPaths = await this.packageManager.resolve();';
const after = `// TransportX: disabled resource discovery must not execute package-manager commands.
        const resolvedPaths = this.noExtensions && this.noSkills && this.noPromptTemplates && this.noThemes
            ? { extensions: [], skills: [], prompts: [], themes: [] }
            : await this.packageManager.resolve();`;
const source = fs.readFileSync(file, 'utf8');
if (source.split(after).length !== 3) {
  if (source.includes(after) || source.split(before).length !== 3) throw new Error('Unexpected Pi loader source; resource discovery patch was not applied');
  fs.writeFileSync(file, source.replaceAll(before, after));
}
