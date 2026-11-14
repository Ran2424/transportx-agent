const { test } = require('node:test') as typeof import('node:test');

test('Desktop updates, shutdown and packaged runtimes enforce lifecycle and platform boundaries', async (t) => {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadRuntimeManifest, validateRuntimeManifest } = require('../../bin/runtime-resolver.js');
  const builder = require('js-yaml').load(fs.readFileSync(path.join(process.cwd(), 'desktop/electron-builder.common.yml'), 'utf8'));
  assert.ok(builder.asarUnpack.includes('modules/**'), 'native module browsing needs complete physical module folders');
  assert.ok(builder.asarUnpack.includes('src/contracts/**'), 'unpacked extensions retain their relative contract imports');
  assert.ok(builder.asarUnpack.includes('dist/web/fonts/native/**'), 'external Python can read physical plotting fonts');
  assert.ok(builder.asarUnpack.includes('dist/module-extensions/**'), 'remapped bundled entries must also be unpacked by their source path');
  const { CORE_TOOL_BINDINGS, coreModulePath } = require('../../bin/contracts/tool-interface.js');
  for (const moduleId of Object.keys(CORE_TOOL_BINDINGS)) {
    const directory = coreModulePath(moduleId);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'modules', directory, 'manifest.json'), 'utf8'));
    for (const entry of manifest.entrypoints.piExtensions) {
      assert.ok(builder.files.includes(`!modules/${directory}/${entry}`), `${moduleId}: exclude the source entry so only the mapped bundle targets its packaged path`);
    }
  }

  // Physical module folders must still load through Pi's extension loader.
  {
    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-unpacked-modules-'));
    t.after(() => fs.rmSync(unpacked, { recursive: true, force: true }));
    const capabilities = path.join(unpacked, 'modules', 'capabilities');
    fs.cpSync(path.join(process.cwd(), 'modules', 'capabilities'), capabilities, { recursive: true });
    fs.cpSync(path.join(process.cwd(), 'dist', 'module-extensions', 'capabilities'), capabilities, { recursive: true });
    assert.equal(fs.existsSync(path.join(unpacked, 'modules', 'shared')), false, 'private build helpers are not runtime dependencies');
    fs.cpSync(path.join(process.cwd(), 'src', 'contracts'), path.join(unpacked, 'src', 'contracts'), { recursive: true });
    const entries = fs.readdirSync(capabilities, { withFileTypes: true }).filter((entry: any) => entry.isDirectory()).flatMap((entry: any) => {
      const root = path.join(capabilities, entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      return (manifest.entrypoints?.piExtensions || []).map((entry: string) => path.join(root, entry));
    });
    const { pathToFileURL } = require('node:url');
    const { loadExtensions } = await import(pathToFileURL(path.join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const previousModules = process.env.TRANSPORTX_SESSION_MODULES_JSON;
    process.env.TRANSPORTX_SESSION_MODULES_JSON = '[]';
    let loaded;
    try { loaded = await loadExtensions(entries, unpacked); }
    finally {
      if (previousModules === undefined) delete process.env.TRANSPORTX_SESSION_MODULES_JSON;
      else process.env.TRANSPORTX_SESSION_MODULES_JSON = previousModules;
    }
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, entries.length);
  }

  // Persistent logs redact credentials, retain bounded archives and tolerate unavailable storage.
  {
    const { createDiagnosticLogger } = require('../../bin/diagnostic-log.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-log-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'runtime.jsonl');
    const log = createDiagnosticLogger(file, 512);
    for (let index = 0; index < 12; index++) log('warn', 'test_event', { index, message: '日志'.repeat(20) });
    assert.deepEqual(fs.readdirSync(root).sort(), ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2', 'runtime.jsonl.3']);
    for (const name of fs.readdirSync(root)) {
      assert.ok(fs.statSync(path.join(root, name)).size <= 512);
      for (const line of fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n')) assert.ok(JSON.parse(line).at);
    }
    const safe = path.join(root, 'safe.jsonl');
    createDiagnosticLogger(safe)('error', 'provider_failed', { sessionId: 'session-1', apiKey: 'field-secret', nested: { token: 'nested-secret' }, message: 'Authorization: Bearer bearer-secret api_key=query-secret password="password-secret" {"apiKey":"json-secret"} OPENAI_API_KEY=env-secret API key=space-secret', path: '\\\\server\\share\\report.csv' });
    createDiagnosticLogger(safe)('info', 'next_start');
    const contents = fs.readFileSync(safe, 'utf8');
    assert.doesNotMatch(contents, /field-secret|nested-secret|bearer-secret|query-secret|password-secret|json-secret|env-secret|space-secret/);
    const records = contents.trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[0].sessionId, 'session-1');
    assert.equal(records[0].path, '//server/share/report.csv');
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'file');
    const warnings: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { const unavailable = createDiagnosticLogger(path.join(blocked, 'error.log')); unavailable('error', 'one'); unavailable('error', 'two'); }
    finally { process.stderr.write = originalWrite; }
    assert.equal(warnings.length, 1);
  }

  function digest(filePath: string) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  const { assertDesktopUpdates } = require('../support/desktop-update-scenarios.ts');
  await assertDesktopUpdates(t);

  // OSS release validation checks architecture/hashes and publishes the manifest last
  {
    const { pathToFileURL } = require('node:url');
    const yaml = require('js-yaml');
    const { createReleasePlan, publishRelease, assertAcceptance, assertBuildProvenance } = await import(pathToFileURL(path.join(process.cwd(), 'desktop/scripts/publish-oss.mjs')).href);
    const { PLATFORM_PROFILES } = await import(pathToFileURL(path.join(process.cwd(), 'desktop/scripts/platform-profile.mjs')).href);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-release-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const profile = PLATFORM_PROFILES.darwin;
    const files = profile.update.requiredExtensions.map((extension: string) => {
      const name = profile.update.artifactName.replace('${version}', '3.23.0').replace('${ext}', extension.slice(1));
      const file = path.join(directory, name);
      fs.writeFileSync(file, `signed-artifact-fixture${extension}`);
      return { url: name, size: fs.statSync(file).size, sha512: crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64') };
    });
    const manifest = { version: '3.23.0', releaseNotes: 'Notes', files };
    const manifestPath = path.join(directory, profile.update.manifest);
    fs.writeFileSync(manifestPath, yaml.dump(manifest));
    const plan = createReleasePlan(directory, '3.23.0', profile);
    assert.equal(plan.files.length, 2);
    assert.throws(() => createReleasePlan(directory, '3.24.0', profile), /mixed-version/);
    files[0].sha512 = 'invalid'; fs.writeFileSync(manifestPath, yaml.dump(manifest));
    assert.throws(() => createReleasePlan(directory, '3.23.0', profile), /SHA-512/);
    files[0].sha512 = crypto.createHash('sha512').update(fs.readFileSync(path.join(directory, files[0].url))).digest('base64');
    fs.writeFileSync(manifestPath, yaml.dump(manifest));
    const sequence: string[] = [];
    const io = {
      readManifest: async () => 'version: 3.22.0\n',
      record: async (record: any) => { sequence.push(record.stage); },
      assertAbsent: async () => { },
      upload: async (_file: any, mutable: boolean) => { sequence.push(mutable ? 'manifest' : 'package'); },
      verify: async (_file: any, mutable: boolean) => { sequence.push(mutable ? 'verify-manifest' : 'verify-package'); },
    };
    await publishRelease(plan, io);
    assert.deepEqual(sequence, ['prepared', ...Array.from({ length: 7 }, () => ['package', 'verify-package']).flat(), 'manifest', 'verify-manifest', 'published']);
    const revision = 'a'.repeat(40);
    const runtime = { product: { version: plan.version }, source: { revision, dirty: false, dependencyLockSha256: 'lock-hash' } };
    assert.doesNotThrow(() => assertBuildProvenance(runtime, plan.version, revision, 'lock-hash'));
    assert.throws(() => assertBuildProvenance({ ...runtime, source: { ...runtime.source, dirty: true } }, plan.version, revision, 'lock-hash'), /provenance/);
    assert.throws(() => assertBuildProvenance(runtime, plan.version, 'b'.repeat(40), 'lock-hash'), /provenance/);
    assert.throws(() => assertBuildProvenance(runtime, plan.version, revision, 'different-lock'), /provenance/);
    const acceptance = { version: plan.version, profile: plan.profile, sourceRevision: revision, testedFromVersion: '3.22.1', testedAt: '2026-10-09T00:00:00Z', testedBy: 'tester', signingIdentity: 'Developer ID fixture', evidence: ['upgrade.log'], signed: true, upgradePassed: true, dataPreserved: true, normalQuitDoesNotInstall: true, sha256: Object.fromEntries(plan.files.map((file: any) => [file.name, file.sha256])) };
    assert.doesNotThrow(() => assertAcceptance(plan, acceptance, revision));
    assert.throws(() => assertAcceptance(plan, acceptance, 'b'.repeat(40)), /source commit/);
    assert.throws(() => assertAcceptance(plan, { ...acceptance, sha256: {} }, revision), /artifacts/);
    assert.throws(() => assertAcceptance(plan, { ...acceptance, evidence: [] }, revision), /evidence/);
    assert.throws(() => assertAcceptance(plan, { ...acceptance, testedFromVersion: '3.24.0' }, revision), /previous version/);
    sequence.length = 0;
    await assert.rejects(publishRelease(plan, { ...io, upload: async () => { throw new Error('upload failed'); } }), /upload failed/);
    assert.equal(sequence.includes('manifest'), false);
    await assert.rejects(publishRelease(plan, { ...io, verify: async () => { throw new Error('verification failed'); } }), /verification failed/);
    assert.equal(sequence.includes('manifest'), false);
    await assert.rejects(publishRelease(plan, { ...io, readManifest: async () => 'version: 3.24.0\n' }), /newer/);
  }

  // platform-profile registry exposes frozen desktop profiles with required contract
  {
    const url = require('node:url');
    const profilePath = path.join(__dirname, '..', '..', 'desktop', 'scripts', 'platform-profile.mjs');
    const profileModule = await import(url.pathToFileURL(profilePath).toString());
    const { PLATFORM_PROFILES, PROCESS_PLATFORM_TO_BUILDER, getPlatformProfile, builderPlatformFor } = profileModule;

    // Every desktop platform resolves through the registry.
    assert.deepEqual({ ...PROCESS_PLATFORM_TO_BUILDER }, { darwin: 'mac', win32: 'win', linux: 'linux' });
    assert.equal(builderPlatformFor('darwin'), 'mac');
    assert.equal(builderPlatformFor('win32'), 'win');
    assert.equal(getPlatformProfile(builderPlatformFor('darwin')), PLATFORM_PROFILES.darwin);
    assert.equal(getPlatformProfile(builderPlatformFor('win32')), PLATFORM_PROFILES.win);
    assert.equal(getPlatformProfile(builderPlatformFor('linux')), PLATFORM_PROFILES.linux);
    if (builderPlatformFor() === 'mac') {
      const { spawnSync } = require('node:child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-internal-signature-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const appId = 'com.transportx.traffic-agent';
      for (const version of [1, 2]) {
        const source = path.join(root, `${version}.c`), binary = path.join(root, `${version}.bin`);
        fs.writeFileSync(source, `int main(){return ${version};}\n`);
        const compiled = spawnSync('clang', [source, '-o', binary], { encoding: 'utf8' });
        assert.equal(compiled.status, 0, compiled.stderr);
        const signed = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', appId, '--requirements', PLATFORM_PROFILES.darwin.signing.internalUpdateRequirement(appId), binary], { encoding: 'utf8' });
        assert.equal(signed.status, 0, signed.stderr);
      }
      const signature = spawnSync('codesign', ['-d', '-r-', path.join(root, '1.bin')], { encoding: 'utf8' });
      const requirement = (signature.stdout + signature.stderr).split('\n').find((line: string) => line.startsWith('designated => '));
      assert.ok(requirement);
      assert.doesNotMatch(requirement, /cdhash/);
      const verified = spawnSync('codesign', ['--verify', '--strict', '-R', '=' + requirement.slice('designated => '.length), path.join(root, '2.bin')], { encoding: 'utf8' });
      assert.equal(verified.status, 0, verified.stderr);
      const rejected = spawnSync('codesign', ['--verify', '--strict', '-R', '=identifier "com.transportx.foreign-app"', path.join(root, '2.bin')], { encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      const fixture = path.join(root, 'Fixture.app');
      const helper = path.join(fixture, 'Contents/Frameworks/Helper.app');
      for (const [bundle, identifier, binary] of [[fixture, appId, '1.bin'], [helper, 'com.transportx.helper', '2.bin']]) {
        fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
        fs.copyFileSync(path.join(root, binary), path.join(bundle, 'Contents/MacOS/run'));
        fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>run</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      }
      const previousUnsigned = process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD;
      try {
        process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD = '1';
        await require('../../desktop/scripts/after-pack.cjs')({ electronPlatformName: 'darwin', appOutDir: root, packager: { appInfo: { productFilename: 'Fixture', id: appId } } });
      } finally {
        if (previousUnsigned === undefined) delete process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD;
        else process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD = previousUnsigned;
      }
      const helperVerified = spawnSync('codesign', ['--verify', '--strict', helper], { encoding: 'utf8' });
      assert.equal(helperVerified.status, 0, helperVerified.stderr);
    } else t.diagnostic('Native ad-hoc requirement checks run on the macOS CI host.');

    const profileExpectations: Record<string, { key: string; builderPlatform: string; installerArtifact: string }> = {
      darwin: { key: 'darwin', builderPlatform: 'mac', installerArtifact: 'dmg' },
      win: { key: 'win', builderPlatform: 'win', installerArtifact: 'nsis' },
      linux: { key: 'linux', builderPlatform: 'linux', installerArtifact: 'deb' },
    };

    for (const [entry, expected] of Object.entries(profileExpectations)) {
      const profile = PLATFORM_PROFILES[entry];
      assert.ok(profile, `profile ${entry} missing`);
      assert.equal(profile.key, expected.key);
      assert.equal(profile.builderPlatform, expected.builderPlatform);
      assert.equal(typeof profile.python.archCheck, 'function');
      assert.match(profile.python.archErrorMessage, /./);
      assert.ok(Array.isArray(profile.python.requiredModules) && profile.python.requiredModules.length >= 4);
      assert.equal(typeof profile.ffmpeg.binName, 'function');
      assert.equal(typeof profile.ffmpeg.chmodRequired, 'boolean');
      assert.equal(typeof profile.ffmpeg.archCheck, 'function');
      assert.match(profile.ffmpeg.arch, /arm64|x64/);
      assert.match(profile.signing.hostArchRequired, /arm64|x64/);
      assert.match(profile.signing.description, /./);
      assert.ok(Array.isArray(profile.signing.requiredEnv));
      assert.equal(profile.signing.requiredEnv.length === 0, entry === 'linux');
      assert.match(profile.signing.allowUnsignedEnv, /./);
      assert.match(profile.signing.allowUnsignedPurpose, /./);
      assert.equal(profile.release.installerArtifact, expected.installerArtifact);
      assert.match(profile.release.productExeBasename, /./);
      assert.match(profile.release.productExeSuffix, /\.exe|/);
      assert.equal(typeof profile.release.requiresFfmpeg, 'boolean');
      assert.equal(typeof profile.release.supportsInstallerSmoke, 'boolean');
      assert.match(profile.release.notes, /./);
    }

    // OS-specific invariants baked into the contract:
    const mac = PLATFORM_PROFILES.darwin;
    assert.equal(mac.release.requiresFfmpeg, false, 'base macOS package excludes the optional video runtime');
    assert.equal(mac.ffmpeg.binName('ffmpeg'), 'ffmpeg', 'mac ffmpeg binary must not have a suffix');
    assert.equal(mac.ffmpeg.chmodRequired, true, 'mac ffmpeg needs +x');
    assert.equal(mac.ffmpeg.arch, 'arm64');
    assert.equal(mac.signing.hostArchRequired, 'arm64');
    assert.equal(mac.python.entry, 'bin/python3');

    const win = PLATFORM_PROFILES.win;
    assert.equal(win.release.requiresFfmpeg, false, 'base Windows package excludes the optional video runtime');
    assert.equal(win.ffmpeg.binName('ffmpeg'), 'ffmpeg.exe', 'win ffmpeg binary must end in .exe');
    assert.equal(win.ffmpeg.chmodRequired, false, 'win ffmpeg inherits +x from NTFS');
    assert.equal(win.ffmpeg.arch, 'x64');
    assert.equal(win.signing.hostArchRequired, 'x64');
    assert.equal(win.python.entry, 'python.exe');
    assert.equal(win.release.installerArtifact, 'nsis');
    assert.equal(typeof win.release.uninstallName, 'string');
    assert.ok(Array.isArray(win.release.installerSilentArgs(path.join('C:', 'install'))));

    const linux = PLATFORM_PROFILES.linux;
    assert.equal(linux.python.archCheck('x86_64'), true);
    assert.equal(linux.python.archCheck('aarch64'), false);
    assert.equal(linux.python.entry, 'bin/python3');
    assert.equal(linux.ffmpeg.binName('ffmpeg'), 'ffmpeg');
    assert.equal(linux.ffmpeg.chmodRequired, true);
    assert.equal(linux.signing.hostArchRequired, 'x64');
    const linuxBuilder = require('js-yaml').load(fs.readFileSync(path.resolve('desktop/electron-builder.linux.yml'), 'utf8'));
    assert.deepEqual(linuxBuilder.linux.target, [{ target: 'deb', arch: 'x64' }]);
    assert.equal(linuxBuilder.linux.executableName, linux.release.productExeBasename);
    const config = require('js-yaml').load(fs.readFileSync(path.resolve('desktop/electron-builder.yml'), 'utf8'));
    assert.ok(config.extends.includes('./desktop/electron-builder.linux.yml'));
    const { websiteReleaseVersion } = require('../../dist-desktop/website-release.js');
    assert.equal(websiteReleaseVersion('<a href="https://download.transkgllm.com/releases/v3.23.1/TransportX-Agent-3.23.1-linux-x64.deb">Linux</a>', linux.update.websiteInstallerPattern), '3.23.1');

    // getPlatformProfile with a non-registered builderPlatform must throw clearly.
    assert.throws(() => getPlatformProfile('plan9'), /Platform profile missing/);
  }

  {
    const { resolveDesktopPaths } = require('../../dist-desktop/app-paths.js');
    const checkout = path.resolve('dev-checkout');
    const electronResources = path.join(checkout, 'node_modules', 'electron', 'resources');
    const userData = path.resolve('desktop-user-data');
    assert.equal(resolveDesktopPaths(checkout, electronResources, userData, false).resourcesDir, checkout, 'development Host resolves modules from the checkout');
    const packagedResources = path.resolve('packaged-resources');
    assert.equal(resolveDesktopPaths(path.join(packagedResources, 'app.asar'), packagedResources, userData, true).resourcesDir, packagedResources);
  }

  // runtime manifest validates relative paths and checksums
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const relative of ['agent-host/tau.js', 'runtimes/pi/cli.js', 'runtimes/python/python']) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative);
    }
    const entry = (relative: string, version: string) => ({ version, path: relative, sha256: digest(path.join(root, relative)) });
    fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
      manifestVersion: 1,
      product: { name: 'TransportX Agent', version: '3.0.3' },
      agentHost: { ...entry('agent-host/tau.js', '3.0.3'), protocolVersion: 2 },
      pi: entry('runtimes/pi/cli.js', '0.80.10'),
      python: entry('runtimes/python/python', '3.10.0'),
    }));
    assert.equal(loadRuntimeManifest(root).product.name, 'TransportX Agent');
    assert.equal(validateRuntimeManifest(root).pi, path.join(root, 'runtimes/pi/cli.js'));
    fs.writeFileSync(path.join(root, 'runtimes/pi/cli.js'), 'tampered');
    assert.throws(() => validateRuntimeManifest(root), /checksum mismatch/);
  }

  // ffmpeg executables resolve from the packaged manifest, env overrides, or dev PATH
  {
    const { resolveFfmpegExecutables } = require('../../bin/runtime-resolver.js');

    // Development desktop mode: no runtime manifest, explicit overrides injected by the supervisor.
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-ffmpeg-dev-'));
    t.after(() => fs.rmSync(devRoot, { recursive: true, force: true }));
    const overridden = resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: true, env: { TAU_FFMPEG_COMMAND: '/opt/homebrew/bin/ffmpeg', TAU_FFPROBE_COMMAND: '/opt/homebrew/bin/ffprobe' } });
    assert.equal(overridden.ffmpeg.command, '/opt/homebrew/bin/ffmpeg');
    assert.equal(overridden.ffprobe.command, '/opt/homebrew/bin/ffprobe');
    assert.throws(() => resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: true, env: {} }), /runtime manifest|ffmpeg/, 'packaged mode without a manifest or overrides must fail loudly');

    // Packaged mode: both entries resolve with checksum validation.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-ffmpeg-packaged-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const relative of ['agent-host/tau.js', 'runtimes/pi/cli.js', 'runtimes/python/python', 'runtimes/ffmpeg/ffmpeg', 'runtimes/ffmpeg/ffprobe']) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative);
    }
    const entry = (relative: string, version: string) => ({ version, path: relative, sha256: digest(path.join(root, relative)) });
    fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
      manifestVersion: 1,
      product: { name: 'TransportX Agent', version: '3.0.9' },
      agentHost: { ...entry('agent-host/tau.js', '3.0.9'), protocolVersion: 2 },
      pi: entry('runtimes/pi/cli.js', '0.80.10'),
      python: entry('runtimes/python/python', '3.10.20'),
      ffmpeg: { ...entry('runtimes/ffmpeg/ffmpeg', '8.0'), arch: 'arm64' },
      ffprobe: { ...entry('runtimes/ffmpeg/ffprobe', '8.0'), arch: 'arm64' },
    }));
    const packaged = resolveFfmpegExecutables({ resourcesDir: root, desktop: true, env: {} });
    assert.equal(packaged.ffmpeg.command, path.join(root, 'runtimes/ffmpeg/ffmpeg'));
    assert.equal(packaged.ffmpeg.version, '8.0');
    assert.equal(packaged.ffprobe.command, path.join(root, 'runtimes/ffmpeg/ffprobe'));

    // Development non-desktop mode falls back to PATH.
    const fallback = resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: false, env: {} });
    assert.equal(fallback.ffmpeg.command, 'ffmpeg');
    assert.equal(fallback.ffprobe.command, 'ffprobe');

    // The desktop supervisor must inject ffmpeg overrides alongside python in development mode.
    const supervisor = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'agent-host-supervisor.ts'), 'utf8');
    assert.match(supervisor, /TAU_FFMPEG_COMMAND/);
    assert.match(supervisor, /TAU_FFPROBE_COMMAND/);
    assert.match(supervisor, /Buffer\.byteLength\(request\.html, 'utf8'\) > 50 \* 1024 \* 1024/);
  }

  // generated Host operations match the single profile and include process-tree and opening facts
  {
    const { pathToFileURL } = require('node:url');
    const { HOST_PLATFORM_OPERATIONS } = await import(pathToFileURL(path.resolve('desktop/scripts/platform-profile.mjs')).href);
    const generated = JSON.parse(fs.readFileSync(path.resolve('bin/host-platform.json'), 'utf8'));
    assert.deepEqual(generated, HOST_PLATFORM_OPERATIONS);
    assert.equal(generated.win32.detached, false);
    assert.equal(generated.win32.treeCommand, 'taskkill');
    assert.deepEqual(generated.win32.treeArgs, ['/pid', '/T']);
    assert.equal(generated.darwin.utilityHost, true);
    assert.deepEqual(generated.linux.packaged, { executableParts: ['transportx-agent'], resourcesParts: ['resources'], executableExtension: '' });
    assert.equal(generated.darwin.systemPrompt, 'PI_SYSTEM_POSIX.md');
    assert.equal(generated.linux.systemPrompt, 'PI_SYSTEM_POSIX.md');
    assert.equal(generated.win32.systemPrompt, 'PI_SYSTEM_WINDOWS.md');
    assert.match(generated.darwin.processInspection.pythonScript, /proc_pidinfo/);
    assert.match(generated.darwin.processInspection.pythonScript, /usec/);
    assert.match(generated.linux.processInspection.pythonScript, /\/proc\//);
    assert.match(generated.win32.processInspection.workspaceScript, /OpenProcessToken/);
    assert.match(generated.win32.processInspection.workspaceScript, /CreateToolhelp32Snapshot/);
    assert.match(generated.win32.processInspection.args.join(' '), /CreationDate/);
    assert.match(generated.win32.processInspection.args.join(' '), /ExecutablePath/);
    const { toPosixPath } = require('../../bin/util/path.js');
    assert.equal(toPosixPath('C:\\tasks\\report'), 'C:/tasks/report');
    assert.equal(toPosixPath('\\\\server\\share\\tasks\\report'), '//server/share/tasks/report');
    const { loadSystemPrompt } = require('../../bin/session-prompt.js');
    const promptRoot = path.resolve('src/server/prompts');
    const basePrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM.md'), 'utf8').trim();
    const posixPrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM_POSIX.md'), 'utf8').trim();
    const windowsPrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM_WINDOWS.md'), 'utf8').trim();
    assert.equal(loadSystemPrompt('darwin'), `${basePrompt}\n\n${posixPrompt}`);
    assert.equal(loadSystemPrompt('linux'), `${basePrompt}\n\n${posixPrompt}`);
    assert.equal(loadSystemPrompt('win32'), `${basePrompt}\n\n${windowsPrompt}`);
    assert.match(loadSystemPrompt('win32'), /2>nul/);
    assert.match(loadSystemPrompt('win32'), /2>\/dev\/null/);
    assert.throws(() => loadSystemPrompt('freebsd'), /Host operations missing/);
    const source = ['src/server/sessions.ts', 'src/server/process-runner.ts', 'src/server/process-tree.ts', 'src/server/file-api-handler.ts', 'src/server/server-main.ts', 'desktop/main.ts', 'desktop/agent-host-supervisor.ts'].map(file => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
    assert.doesNotMatch(source, /process\.platform\s*[!=]==\s*['"]/);
  }
});
