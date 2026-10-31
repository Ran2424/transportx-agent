// Platform profile registry for the TransportX desktop release pipeline.
//
// Adding a new supported OS now means declaring one entry in PLATFORM_PROFILES
// and (if applicable) one fragment under desktop/electron-builder.fragments/.
// Runtime preparation, signing, electron-builder wiring and installer smoke
// scripts all read from this single source of truth instead of branching on
// `process.platform`.

import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PROCESS_PLATFORM_TO_BUILDER = Object.freeze({
  darwin: 'mac',
  win32: 'win',
  linux: 'linux',
});

export function builderPlatformFor(platform = process.platform) {
  const builder = PROCESS_PLATFORM_TO_BUILDER[platform];
  if (!builder) throw new Error(`No platform profile registered for ${platform}`);
  return builder;
}

export function getPlatformProfile(builderPlatform = builderPlatformFor()) {
  const profile = Object.values(PLATFORM_PROFILES).find((entry) => entry.builderPlatform === builderPlatform);
  if (!profile) throw new Error(`Platform profile missing: ${builderPlatform}`);
  return profile;
}

// `pythonEntry` is the entry path RELATIVE to the staged runtime directory.
// `archCheck` receives platform.machine() output and returns true on success.
// `archErrorMessage` is the human-readable architecture requirement (used in
// error messages).
const PYTHON_REQUIRED_MODULES = ['ssl', 'sqlite3', 'yaml', 'numpy', 'matplotlib', 'pandas', 'pyproj', 'shapely', 'ezdxf'];

const PYTHON_PROFILE = {
  darwin: {
    entry: 'bin/python3',
    archCheck: (machine) => machine === 'arm64',
    archErrorMessage: 'arm64',
    requiredModules: PYTHON_REQUIRED_MODULES,
  },
  win: {
    entry: 'python.exe',
    archCheck: (machine) => /^(amd64|x86_64)$/i.test(String(machine)),
    archErrorMessage: 'x64',
    requiredModules: PYTHON_REQUIRED_MODULES,
  },
  linux: {
    entry: 'bin/python3',
    archCheck: (machine) => machine === 'x86_64',
    archErrorMessage: 'x64',
    requiredModules: PYTHON_REQUIRED_MODULES,
  },
};

function darwinFfmpegArchCheck(binaryPath) {
  const fileResult = spawnSync('file', [binaryPath], { encoding: 'utf8' });
  if (fileResult.status !== 0) throw new Error(`Cannot inspect ${binaryPath}: ${(fileResult.stderr || fileResult.stdout || '').trim()}`);
  if (!fileResult.stdout.includes('arm64')) throw new Error(`Bundled macOS ${path.basename(binaryPath)} must be arm64: ${fileResult.stdout.trim()}`);
}

function noopFfmpegArchCheck() {
  // Windows / static ffmpeg builds are validated by filename + version probe alone.
}

function linuxFfmpegArchCheck(binaryPath) {
  const result = spawnSync('file', [binaryPath], { encoding: 'utf8' });
  if (result.status !== 0 || !/ELF 64-bit.*x86-64/.test(result.stdout)) {
    throw new Error(`Bundled Linux ${path.basename(binaryPath)} must be an x64 ELF binary: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

const FFMPEG_PROFILE = {
  darwin: {
    binName: (name) => name,
    chmodRequired: true,
    archCheck: darwinFfmpegArchCheck,
    arch: 'arm64',
  },
  win: {
    binName: (name) => `${name}.exe`,
    chmodRequired: false,
    archCheck: noopFfmpegArchCheck,
    arch: 'x64',
  },
  linux: {
    binName: (name) => name,
    chmodRequired: true,
    archCheck: linuxFfmpegArchCheck,
    arch: 'x64',
  },
};

const SIGNING_PROFILE = {
  darwin: {
    hostArchRequired: 'arm64',
    description: 'macOS release requires Developer ID Application signing + Apple notarization.',
    requiredEnv: [
      { name: 'CSC_LINK', purpose: 'Apple Developer ID certificate (.p12) base64 or path' },
      { name: 'CSC_KEY_PASSWORD', purpose: 'Certificate password' },
    ],
    notes: 'Both Developer ID variables or notarization credentials must be configured for notarization to succeed.',
    allowUnsignedEnv: 'TRANSPORTX_ALLOW_UNSIGNED_BUILD',
    internalUpdateRequirement: (appId) => `=designated => identifier "${appId}"`,
    allowUnsignedPurpose: 'internal ad-hoc signing for unsigned macOS test DMGs only',
  },
  win: {
    hostArchRequired: 'x64',
    description: 'Windows release requires an Authenticode certificate with trusted timestamp.',
    requiredEnv: [
      { name: 'WIN_CSC_LINK', purpose: 'Authenticode certificate (.pfx) path or base64' },
      { name: 'WIN_CSC_KEY_PASSWORD', purpose: 'Certificate password' },
      { name: 'CSC_LINK', purpose: 'Shared electron-builder certificate (fallback)' },
      { name: 'WIN_CSC_NAME', purpose: 'Windows certificate store subject name (fallback)' },
      { name: 'CSC_NAME', purpose: 'Shared electron-builder subject name (fallback)' },
    ],
    notes: 'Configure one of (WIN_CSC_LINK / WIN_CSC_NAME) or the corresponding CSC_* fallback.',
    allowUnsignedEnv: 'TRANSPORTX_ALLOW_UNSIGNED_BUILD',
    allowUnsignedPurpose: 'internal structure verification of unsigned Windows installers only',
  },
  linux: {
    hostArchRequired: 'x64',
    description: 'Linux x64 DEB packages do not use platform code signing; distribute the SHA-256 checksum with the installer.',
    requiredEnv: [],
    allowUnsignedEnv: 'TRANSPORTX_ALLOW_UNSIGNED_BUILD',
    allowUnsignedPurpose: 'Linux DEB packages do not require a signing bypass',
  },
};

const RELEASE_PROFILE = {
  darwin: {
    label: 'macOS arm64',
    installerArtifact: 'dmg',
    productExeBasename: 'TransportX Agent',
    productExeSuffix: '',
    requiresFfmpeg: false,
    supportsInstallerSmoke: false,
    notes: 'DMG layout verified via desktop-smoke. Notarization performed by electron-builder.',
  },
  win: {
    label: 'Windows x64',
    installerArtifact: 'nsis',
    productExeBasename: 'TransportX Agent',
    productExeSuffix: '.exe',
    productExeName: 'TransportX Agent.exe',
    uninstallName: 'Uninstall TransportX Agent.exe',
    installerSilentArgs: (installDir) => ['/S', `/D=${installDir}`],
    uninstallerSilentArgs: ['/S'],
    requiresFfmpeg: false,
    supportsInstallerSmoke: true,
    notes: 'NSIS silent install/launch/uninstall validated by test:windows-installer-smoke.',
  },
  linux: {
    label: 'Linux x64',
    installerArtifact: 'deb',
    productExeBasename: 'transportx-agent',
    productExeSuffix: '',
    requiresFfmpeg: false,
    supportsInstallerSmoke: true,
    notes: 'DEB install/launch/uninstall verified on Linux CI; UOS V20 requires separate target-machine acceptance.',
  },
};

// Adding a new OS = add an entry here + an `electron-builder.<key>.yml` fragment.
export const PLATFORM_PROFILES = Object.freeze({
  darwin: Object.freeze({
    key: 'darwin',
    builderPlatform: 'mac',
    label: RELEASE_PROFILE.darwin.label,
    python: PYTHON_PROFILE.darwin,
    ffmpeg: FFMPEG_PROFILE.darwin,
    signing: SIGNING_PROFILE.darwin,
    release: RELEASE_PROFILE.darwin,
    update: Object.freeze({
      directory: 'updates/stable/mac-arm64/',
      url: 'https://download.transkgllm.com/updates/stable/mac-arm64/',
      manifest: 'latest-mac.yml',
      websiteInstallerPattern: '^TransportX[.-]Agent-((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))-(?:mac-)?arm64\\.dmg$',
      artifactName: 'TransportX-Agent-${version}-mac-arm64.${ext}',
      requiredExtensions: ['.dmg', '.zip'],
    }),
  }),
  win: Object.freeze({
    key: 'win',
    builderPlatform: 'win',
    label: RELEASE_PROFILE.win.label,
    python: PYTHON_PROFILE.win,
    ffmpeg: FFMPEG_PROFILE.win,
    signing: SIGNING_PROFILE.win,
    release: RELEASE_PROFILE.win,
    update: Object.freeze({
      directory: 'updates/stable/win-x64/',
      url: 'https://download.transkgllm.com/updates/stable/win-x64/',
      manifest: 'latest.yml',
      websiteInstallerPattern: '^TransportX[.-]Agent-((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))-win-x64-setup\\.exe$',
      artifactName: 'TransportX-Agent-${version}-win-x64-setup.${ext}',
      requiredExtensions: ['.exe'],
    }),
  }),
  linux: Object.freeze({
    key: 'linux',
    builderPlatform: 'linux',
    label: RELEASE_PROFILE.linux.label,
    python: PYTHON_PROFILE.linux,
    ffmpeg: FFMPEG_PROFILE.linux,
    signing: SIGNING_PROFILE.linux,
    release: RELEASE_PROFILE.linux,
    update: Object.freeze({
      directory: 'updates/stable/linux-x64/',
      url: 'https://download.transkgllm.com/updates/stable/linux-x64/',
      manifest: 'latest-linux.yml',
      websiteInstallerPattern: '^TransportX[.-]Agent-((?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))-linux-x64\\.deb$',
      artifactName: 'TransportX-Agent-${version}-linux-x64.${ext}',
      requiredExtensions: ['.deb'],
    }),
  }),
});

// Runtime operations are also generated into bin/host-platform.json.
const PROCESS_INSPECTION = {
  darwin: {
    workspaceScript: `import json,os,subprocess
p=subprocess.run(['/usr/sbin/lsof','-a','-u',str(os.geteuid()),'-d','cwd','-F0pcn'],capture_output=True,timeout=15,env=dict(os.environ,LC_ALL='en_US.UTF-8',LANG='en_US.UTF-8'))
if p.returncode or p.stderr: raise RuntimeError('Current-user cwd inventory is incomplete')
records=[];item=None
for field in p.stdout.decode('utf-8').split('\\0'):
 field=field.lstrip('\\n')
 if field.startswith('p'):
  if item: records.append(item)
  item={'pid':int(field[1:]),'cwd':None}
 elif field.startswith('n') and item: item['cwd']=field[1:]
if item: records.append(item)
print(json.dumps({'processes':[r for r in records if r['pid']!=os.getpid()]}))`,
    // proc_bsdinfo / PROC_PIDTBSDINFO from the Apple SDK sys/proc_info.h.
    // Kernel microseconds remain stable when Node changes process.title.
    pythonScript: `import ctypes as c,json,sys
class Info(c.Structure):
 _fields_=[('prefix',c.c_uint32*12),('comm',c.c_char*16),('name',c.c_char*32),('suffix',c.c_uint32*6),('sec',c.c_uint64),('usec',c.c_uint64)]
lib=c.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[c.c_int,c.c_int,c.c_uint64,c.c_void_p,c.c_int]
lib.proc_pidpath.argtypes=[c.c_int,c.c_void_p,c.c_uint32]
pid=int(sys.argv[1]);info=Info();name=c.create_string_buffer(4096)
if lib.proc_pidinfo(pid,3,0,c.byref(info),c.sizeof(info))!=c.sizeof(info) or lib.proc_pidpath(pid,name,len(name))<=0: raise OSError(c.get_errno(),'Process identity unavailable')
print(json.dumps(dict(state='running',pid=info.prefix[3],parentPid=info.prefix[4],groupId=info.suffix[1],startedAt=f'{info.sec}.{info.usec:06d}',command=name.value.decode())))`,
    bootCommand: 'sysctl', bootArgs: ['-n', 'kern.boottime'],
  },
  linux: {
    workspaceScript: `import json,os
records=[]
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name)==os.getpid(): continue
 root='/proc/'+name
 try:
  if os.stat(root).st_uid!=os.geteuid(): continue
  records.append({'pid':int(name),'cwd':os.readlink(root+'/cwd')})
 except FileNotFoundError: pass
 except PermissionError: records.append({'pid':int(name),'cwd':None})
print(json.dumps({'processes':records}))`,
    pythonScript: `import json,os,sys
pid=int(sys.argv[1]);root=f'/proc/{pid}';value=open(root+'/stat').read();parts=value[value.rfind(')')+2:].split()
print(json.dumps(dict(state='running',pid=pid,parentPid=int(parts[1]),groupId=int(parts[2]),startedAt=parts[19],command=os.readlink(root+'/exe'))))`,
    bootCommand: 'cat', bootArgs: ['/proc/sys/kernel/random/boot_id'],
  },
  win32: {
    // x64 PEB / RTL_USER_PROCESS_PARAMETERS layouts: winsiderss/phnt
    // ntpebteb.h and ntrtl.h. Only same-user processes with a confirmed cwd
    // can establish workspace membership; protected desktop components are omitted.
    workspaceScript: `import ctypes as c,ctypes.wintypes as w,json,os,struct,sys
if c.sizeof(c.c_void_p)!=8: raise RuntimeError('64-bit process inventory is required')
k=c.WinDLL('kernel32',use_last_error=True);a=c.WinDLL('advapi32',use_last_error=True);nt=c.WinDLL('ntdll')
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE]
k.ReadProcessMemory.argtypes=[w.HANDLE,c.c_void_p,c.c_void_p,c.c_size_t,c.POINTER(c.c_size_t)]
k.GetCurrentProcess.restype=w.HANDLE
a.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,c.POINTER(w.HANDLE)]
a.GetTokenInformation.argtypes=[w.HANDLE,w.DWORD,c.c_void_p,w.DWORD,c.POINTER(w.DWORD)]
a.GetLengthSid.argtypes=[c.c_void_p];a.GetLengthSid.restype=w.DWORD
nt.NtQueryInformationProcess.argtypes=[w.HANDLE,w.ULONG,c.c_void_p,w.ULONG,c.c_void_p]
session=w.DWORD()
if not k.ProcessIdToSessionId(int(sys.argv[1]),c.byref(session)): raise RuntimeError('Host session unavailable')
class ProcessEntry(c.Structure):
 _fields_=[('size',w.DWORD),('usage',w.DWORD),('pid',w.DWORD),('heap',c.c_size_t),('module',w.DWORD),('threads',w.DWORD),('parent',w.DWORD),('priority',w.LONG),('flags',w.DWORD),('exe',w.WCHAR*260)]
class SidAndAttributes(c.Structure): _fields_=[('sid',c.c_void_p),('attributes',w.DWORD)]
class TokenUser(c.Structure): _fields_=[('user',SidAndAttributes)]
def user_sid(handle):
 token=w.HANDLE();size=w.DWORD()
 if not a.OpenProcessToken(handle,0x8,c.byref(token)): return None
 try:
  a.GetTokenInformation(token,1,None,0,c.byref(size))
  if not size.value: return None
  data=c.create_string_buffer(size.value)
  if not a.GetTokenInformation(token,1,data,size,c.byref(size)): return None
  sid=c.cast(data,c.POINTER(TokenUser)).contents.user.sid
  length=a.GetLengthSid(sid)
  return c.string_at(sid,length) if length else None
 finally: k.CloseHandle(token)
owner=user_sid(k.GetCurrentProcess())
if not owner: raise RuntimeError('Current user identity unavailable')
snapshot=k.CreateToolhelp32Snapshot(2,0)
if snapshot==w.HANDLE(-1).value: raise OSError('Process snapshot unavailable')
pids=[];entry=ProcessEntry();entry.size=c.sizeof(entry)
try:
 more=k.Process32FirstW(snapshot,c.byref(entry))
 while more:
  candidate=int(entry.pid);candidate_session=w.DWORD()
  if candidate and k.ProcessIdToSessionId(candidate,c.byref(candidate_session)) and candidate_session.value==session.value:
   identity=k.OpenProcess(0x1000,False,candidate)
   try:
    if identity and user_sid(identity)==owner: pids.append(candidate)
   finally:
    if identity: k.CloseHandle(identity)
  more=k.Process32NextW(snapshot,c.byref(entry))
finally: k.CloseHandle(snapshot)
class Basic(c.Structure):
 _fields_=[('reserved',c.c_void_p),('peb',c.c_void_p),('padding',c.c_void_p*2),('pid',c.c_size_t),('last',c.c_void_p)]
def read(handle,address,size):
 data=c.create_string_buffer(size);count=c.c_size_t()
 if not k.ReadProcessMemory(handle,c.c_void_p(address),data,size,c.byref(count)) or count.value!=size: raise OSError('Process parameters unavailable')
 return data.raw
records=[]
for pid in pids:
 if pid==os.getpid(): continue
 handle=k.OpenProcess(0x410,False,pid);cwd=None
 try:
  if not handle: raise OSError('Process access unavailable')
  basic=Basic()
  if nt.NtQueryInformationProcess(handle,0,c.byref(basic),c.sizeof(basic),None): raise OSError('Process basic information unavailable')
  parameters=struct.unpack('<Q',read(handle,basic.peb+0x20,8))[0]
  value=read(handle,parameters+0x38,16);length=struct.unpack_from('<H',value)[0];address=struct.unpack_from('<Q',value,8)[0]
  if not length or length>32766 or length%2: raise OSError('Current directory unavailable')
  cwd=read(handle,address,length).decode('utf-16-le')
 except OSError: pass
 finally:
  if handle: k.CloseHandle(handle)
 if cwd is not None: records.append({'pid':pid,'cwd':cwd})
print(json.dumps({'processes':records}))`,
    command: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', "$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction Stop;if($null -eq $p){@{state='exited'}|ConvertTo-Json -Compress}else{@{state='running';pid=$p.ProcessId;parentPid=$p.ParentProcessId;startedAt=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.ExecutablePath}|ConvertTo-Json -Compress}"],
    bootCommand: 'powershell', bootArgs: ['-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')"],
  },
};
export const HOST_PLATFORM_OPERATIONS = Object.freeze({
  darwin: { processInspection: PROCESS_INSPECTION.darwin, systemPrompt: 'PI_SYSTEM_POSIX.md', updateInstallerPattern: PLATFORM_PROFILES.darwin.update.websiteInstallerPattern, posixPermissions: true, detached: true, tree: 'process-group', openCommand: 'open', detachedOpen: false, utilityHost: true, insetTitleBar: true, dataRoot: { env: null, fallback: [], parts: ['.transportx', 'traffic-agent'] }, packaged: { executableParts: ['Contents', 'MacOS', RELEASE_PROFILE.darwin.productExeBasename], resourcesParts: ['Contents', 'Resources'], executableExtension: '' } },
  win32: { processInspection: PROCESS_INSPECTION.win32, systemPrompt: 'PI_SYSTEM_WINDOWS.md', updateInstallerPattern: PLATFORM_PROFILES.win.update.websiteInstallerPattern, posixPermissions: false, detached: false, tree: 'taskkill', treeCommand: 'taskkill', treeArgs: ['/pid', '/T'], treeForceArg: '/F', openCommand: 'explorer.exe', detachedOpen: true, utilityHost: false, insetTitleBar: false, dataRoot: { env: 'APPDATA', fallback: ['AppData', 'Roaming'], parts: ['TransportX', 'traffic-agent'] }, packaged: { executableParts: [RELEASE_PROFILE.win.productExeName], resourcesParts: ['resources'], executableExtension: RELEASE_PROFILE.win.productExeSuffix } },
  linux: { processInspection: PROCESS_INSPECTION.linux, systemPrompt: 'PI_SYSTEM_POSIX.md', updateInstallerPattern: PLATFORM_PROFILES.linux.update.websiteInstallerPattern, posixPermissions: true, desktopDataRoot: 'electron', detached: true, tree: 'process-group', openCommand: 'xdg-open', detachedOpen: false, utilityHost: false, insetTitleBar: false, dataRoot: { env: 'XDG_CONFIG_HOME', fallback: ['.config'], parts: ['transportx-traffic-agent'] }, packaged: { executableParts: [RELEASE_PROFILE.linux.productExeBasename], resourcesParts: ['resources'], executableExtension: '' } },
});

export function hostPlatformOperations(platform = process.platform) {
  const profile = HOST_PLATFORM_OPERATIONS[platform];
  if (!profile) throw new Error(`Host operations missing for ${platform}`);
  return profile;
}
