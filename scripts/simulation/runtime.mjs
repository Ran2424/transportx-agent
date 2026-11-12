// Inspect and relocate the actual native dependency closure. Never installs globally.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getSimulationProbeProfile } from '../../desktop/scripts/platform-profile.mjs';
import { sha256 } from './job.mjs';
const require = createRequire(import.meta.url);
const { ProcessRunner } = require('../../bin/process-runner.js');
const { toPosixPath } = require('../../bin/util/path.js');
const { isWithin } = require('../../bin/util/path.js');

export function loadRuntime(directory) {
  const root = fs.realpathSync(directory);
  const evidence = JSON.parse(fs.readFileSync(path.join(path.dirname(root), 'runtime-evidence.json'), 'utf8'));
  if (evidence.protocol !== 'transportx-sumo-p0-runtime' || evidence.version !== 1 || ['sumo', 'netconvert', 'duarouter'].some((name) => evidence.versions[name]?.status !== 'passed')) throw new Error('runtime_probe_unconfirmed');
  for (const entry of evidence.files) {
    const file = fs.realpathSync(path.join(root, entry.path));
    if (!isWithin(root, file) || sha256(fs.readFileSync(file)) !== entry.sha256) throw new Error('runtime_integrity');
  }
  const profile = getSimulationProbeProfile();
  return { sumo: path.join(root, 'sumo', 'bin', profile.executable('sumo')), netconvert: path.join(root, 'sumo', 'bin', profile.executable('netconvert')), pythonPath: path.join(root, 'python'), evidence };
}

export async function stageRuntime(dependencies, root) {
  const profile = getSimulationProbeProfile();
  const runner = new ProcessRunner();
  const source = fs.realpathSync(dependencies);
  const staging = path.join(root, 'runtime-staging');
  const relocated = path.join(root, 'relocated runtime');
  const pending = ['sumo', 'netconvert', 'duarouter'].map((name) => path.join(source, 'sumo', 'bin', profile.executable(name)));
  const files = new Map(), links = [];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const real = fs.realpathSync(file);
    const relative = toPosixPath(path.relative(source, file));
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('runtime_dependency_outside_source');
    files.set(file, { path: relative, sha256: sha256(fs.readFileSync(real)), bytes: fs.statSync(real).size });
    const result = await runner.run({ command: profile.dependencyCommand, args: [] }, profile.dependencyArgs(real), { envMode: 'replace', env: {}, timeoutMs: 10000, maxBuffer: 65536 });
    const dependencies = [...result.stdout.matchAll(/^\t(.+) \(compatibility/gm)].map((match) => match[1]);
    // otool lists a dylib's own install ID first; that ID is not a load dependency.
    if (file.endsWith('.dylib')) dependencies.shift();
    for (const dependency of dependencies) {
      if (/^\/(usr\/lib|System\/Library)\//.test(dependency)) continue;
      if (!dependency.startsWith('@loader_path/')) throw new Error(`runtime_external_dependency: ${dependency}`);
      const resolved = path.resolve(path.dirname(file), dependency.slice('@loader_path/'.length));
      links.push({ from: relative, dependency });
      pending.push(resolved);
    }
  }
  for (const [file, entry] of files) {
    const target = path.join(staging, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(fs.realpathSync(file), target);
    fs.chmodSync(target, fs.statSync(file).mode);
  }
  for (const name of ['traci', 'sumolib']) fs.cpSync(path.join(source, name), path.join(staging, 'python', name), { recursive: true, dereference: true, filter: (file) => path.basename(file) !== '__pycache__' });
  // Keep the source licenses next to the evidence, rather than claiming a distribution audit passed.
  const notices = ['eclipse_sumo', 'sumo_data', 'traci', 'sumolib'].map((name) => `${name}-1.28.0.dist-info/licenses`);
  for (const notice of notices) fs.cpSync(path.join(source, notice), path.join(staging, 'notices', path.dirname(notice)), { recursive: true, dereference: true });
  fs.renameSync(staging, relocated);
  const versions = {};
  const evidence = { protocol: 'transportx-sumo-p0-runtime', version: 1, wheelTag: profile.wheelTag, files: [...files.values()], links, versions,
    nativeBytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0), startupTimeoutMs: profile.startupTimeoutMs,
    scope: 'relocated native closure and pure Python clients in empty environment; developer Python; not clean-machine or signed-package acceptance' };
  const save = () => fs.writeFileSync(path.join(root, 'runtime-evidence.json'), JSON.stringify(evidence, null, 2));
  save();
  for (const name of ['sumo', 'netconvert', 'duarouter']) {
    const file = path.join(relocated, 'sumo', 'bin', profile.executable(name));
    const started = Date.now();
    console.log(`P0 runtime: probing ${name}`);
    try {
      const result = await runner.run({ command: file, args: [] }, ['--version'], { cwd: root, envMode: 'replace', env: {}, timeoutMs: profile.startupTimeoutMs, maxBuffer: 65536 });
      if (!result.stdout.includes('1.28.0')) throw new Error('runtime_version_mismatch');
      versions[name] = { status: 'passed', stdout: result.stdout, wallMilliseconds: Date.now() - started };
    } catch (error) {
      versions[name] = { status: 'failed', error: error.message, wallMilliseconds: Date.now() - started };
      save();
      throw error;
    }
    save();
  }
  const binary = path.join(relocated, 'sumo', 'bin', profile.executable('sumo'));
  const architecture = await runner.run({ command: profile.architectureCommand, args: [] }, profile.architectureArgs(binary), { envMode: 'replace', env: {}, timeoutMs: 10000, maxBuffer: 4096 });
  evidence.architecture = architecture.stdout;
  save();
  return { sumo: binary, netconvert: path.join(relocated, 'sumo', 'bin', profile.executable('netconvert')), pythonPath: path.join(relocated, 'python'), evidence };
}

export async function inspectNativeProcess(pid) {
  const profile = getSimulationProbeProfile();
  const result = await new ProcessRunner().run({ command: profile.processCommand, args: [] }, profile.processArgs(pid), { envMode: 'replace', env: {}, timeoutMs: 5000, maxBuffer: 65536 });
  const bytes = Number(result.stdout.trim().split(/\s+/)[0]) * 1024;
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('native_memory_probe');
  if (result.stdout.includes('TRANSPORTX_TEST_PARENT_SECRET=') || result.stdout.includes('TAU_SESSION_TOKEN=')) throw new Error('native_environment_leak');
  return { rssBytes: bytes, parentMarkersAbsent: true };
}
