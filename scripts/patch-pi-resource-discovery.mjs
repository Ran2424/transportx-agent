// Pi remains the runtime. Pin this small loader fix until upstream can skip
// package discovery when every automatically discovered resource is disabled.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url);
const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
if (version !== '0.80.10') throw new Error('Re-audit the Pi compatibility patches before upgrading Pi');
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

// The Host authorizes this provider while idle Pi RPC children may already be
// running. Read through Pi's credential lock so they see login/logout and a
// refresh token rotated by another process.
const authFile = fileURLToPath(new URL('dist/core/auth-storage.js', root));
const authSource = fs.readFileSync(authFile, 'utf8');
const oldRead = 'async read(provider) {\n        const credential = this.data[provider];';
const newRead = 'async read(provider) {\n        if (provider === "openai-chatgpt") return this.modify(provider, async () => undefined);\n        const credential = this.data[provider];';
if (!authSource.includes(newRead)) {
  if (authSource.split(oldRead).length !== 2) throw new Error('Unexpected Pi credential reader; ChatGPT credential sync patch was not applied');
  fs.writeFileSync(authFile, authSource.replace(oldRead, newRead));
}
