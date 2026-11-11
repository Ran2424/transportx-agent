import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import yazl from 'yazl';
import { stageRuntime } from '../../scripts/simulation/runtime.mjs';
import { getSimulationProbeProfile } from './platform-profile.mjs';
const require = createRequire(import.meta.url);
const { sha256File } = require('../../bin/asset-integrity.js');
const { toPosixPath } = require('../../bin/util/path.js');
const dependencies = process.env.TRANSPORTX_SIMULATION_DEPS;
if (!dependencies) throw new Error('TRANSPORTX_SIMULATION_DEPS must explicitly name the locked wheel installation');
const profile = getSimulationProbeProfile();
const source = path.resolve('dist/tool-modules/traffic-simulation');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const builtin = process.argv.includes('--builtin');
const stage = path.resolve(builtin ? 'desktop/build/traffic-simulation-native' : 'desktop/build/traffic-simulation');
fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
const packageRoot = builtin ? path.resolve('desktop/build/builtin-modules/traffic-simulation') : path.join(stage, manifest.id, manifest.version);
if (builtin) fs.rmSync(packageRoot, { recursive: true, force: true });
fs.cpSync(source, packageRoot, { recursive: true });
fs.copyFileSync(path.resolve('LICENSE'), path.join(packageRoot, 'LICENSE'));
const runtimeBuild = path.join(stage, 'native'); fs.mkdirSync(runtimeBuild);
const runtime = await stageRuntime(dependencies, runtimeBuild);
const nativeRoot = path.join(packageRoot, 'runtimes', 'sumo'); fs.mkdirSync(path.dirname(nativeRoot), { recursive: true });
fs.renameSync(path.dirname(runtime.pythonPath), nativeRoot);
fs.cpSync(path.join(path.resolve(dependencies), ...profile.projDataRelative), path.join(nativeRoot, ...profile.projDataRelative), { recursive: true, dereference: true });
const relative = (file) => toPosixPath(path.relative(packageRoot, file));
const entry = (file) => ({ path: relative(file), sha256: sha256File(file) });
const checksum = path.join(packageRoot, 'SHA256SUMS');
const files = [];
function collect(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Runtime package contains a symbolic link');
    if (item.isDirectory()) collect(file);
    else if (file !== checksum && file !== path.join(packageRoot, 'manifest.json')) files.push(file);
  }
}
collect(packageRoot);
fs.writeFileSync(checksum, files.sort().map((file) => `${sha256File(file)}  ${relative(file)}`).join('\n') + '\n');
manifest.contributes.nativeRuntimes = [{ id: 'sumo', kind: 'sumo', platform: process.platform, arch: process.arch, version: '1.28.0',
  executables: Object.fromEntries(['sumo', 'netconvert', 'duarouter'].map((name) => [name, entry(path.join(nativeRoot, 'sumo', 'bin', profile.executable(name)))])),
  pythonPath: relative(path.join(nativeRoot, 'python')), projData: relative(path.join(nativeRoot, ...profile.projDataRelative)),
  integrityFile: entry(checksum), notices: relative(path.join(nativeRoot, 'notices', 'eclipse_sumo-1.28.0.dist-info', 'LICENSE')) }];
fs.writeFileSync(path.join(packageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const { validateModulePackage } = require('../../bin/module-installer.js'); validateModulePackage(packageRoot, manifest);
if (builtin) {
  console.log(`Prepared built-in Traffic Simulation ${manifest.version} at ${packageRoot}`);
  process.exit(0);
}
const release = path.resolve('release/modules'); fs.mkdirSync(release, { recursive: true });
const output = path.join(release, `transportx-traffic-simulation-${manifest.version}-${process.platform}-${process.arch}.zip`);
await new Promise((resolve, reject) => {
  const zip = new yazl.ZipFile();
  for (const file of [path.join(packageRoot, 'manifest.json'), checksum, ...files]) zip.addFile(file, relative(file));
  zip.end(); const stream = fs.createWriteStream(output);
  zip.outputStream.pipe(stream); stream.on('close', resolve); stream.on('error', reject); zip.outputStream.on('error', reject);
});
fs.writeFileSync(output + '.sha256', `${sha256File(output)}  ${path.basename(output)}\n`);
const demoRoot = path.resolve('modules/optional/hongqiao-night-demo');
const demoManifest = JSON.parse(fs.readFileSync(path.join(demoRoot, 'manifest.json'), 'utf8'));
validateModulePackage(demoRoot, demoManifest);
const demoOutput = path.join(release, `transportx-hongqiao-night-demo-${demoManifest.version}.zip`);
await new Promise((resolve, reject) => {
  const zip = new yazl.ZipFile();
  function add(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Demo package contains a symbolic link');
      if (item.isDirectory()) add(file); else zip.addFile(file, toPosixPath(path.relative(demoRoot, file)));
    }
  }
  add(demoRoot); zip.addFile(path.resolve('LICENSE'), 'LICENSE'); zip.end();
  const stream = fs.createWriteStream(demoOutput); zip.outputStream.pipe(stream);
  stream.on('close', resolve); stream.on('error', reject); zip.outputStream.on('error', reject);
});
fs.writeFileSync(demoOutput + '.sha256', `${sha256File(demoOutput)}  ${path.basename(demoOutput)}\n`);
console.log(JSON.stringify({ packageRoot, zip: output, demoZip: demoOutput, version: manifest.version, bytes: fs.statSync(output).size, sha256: sha256File(output), scope: 'development package; P4 signing and license closure acceptance pending' }));
