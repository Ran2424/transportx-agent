# Linux x64 测试安装包

目标为统信 UOS V20 专业版 1070、兆芯 KX-U6780A（x86_64）、glibc 2.28。包格式为 DEB，当前为适配测试包，尚未通过 UOS 实机验收或厂商兼容认证，不上传官网或正式更新源。

## 构建与验证

在 Linux x64 主机上准备自包含 Python 3.10 runtime，安装 `desktop/python-requirements.txt` 的全部依赖，再执行：

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR="<python-runtime-directory>" npm run desktop:pack -- --publish=never
```

Linux 不要求 macOS/Windows 代码签名凭据；构建流程仍检查主机与 Python 架构、Python 版本及必需模块。基础包不含可选 Video Capability 的 ffmpeg，当前也不提供受支持的 Linux Video Capability 安装包；Native Runtime 安装契约仍限于 macOS/Windows。

GitHub Actions 的 `Linux x64 test package` 工作流使用 Ubuntu 22.04 x64，下载固定版本和 SHA-256 的可重定位 Python，执行类型检查、桌面契约测试，并安装实际 DEB 后运行桌面冒烟和卸载检查。工作流产出安装包、SHA-256 和 `linux-x64-validation.txt`，其中记录 CI 系统和包内 x64 ELF 引用的运行库版本，并阻止高于 glibc 2.28 的 x64 依赖通过检查。依赖可能附带其他架构的预编译文件；它们不参与 x64 的运行库基线判断。这些检查不等于 UOS 实机验收。

## 目标机验收

1. 核对 SHA-256 后，通过 UOS 软件包安装器安装 `TransportX-Agent-<version>-linux-x64.deb`；单位受管终端由管理员按准入策略安装。
2. 使用普通用户从应用菜单启动 TransportX Agent，核对工作台、设置、任务目录与模块列表。
3. 配置单位允许使用的模型接口，验证创建任务、文件分析、地图与报告导出；断网场景还需核查模型、底图及联网功能。
4. 关闭应用后确认 Host 退出，再验证重启与卸载；保留用户任务资料。

不要为启动应用替换系统 glibc、关闭沙箱或使用 root 运行。遇到动态库或沙箱错误时保留终端输出，按具体系统环境修复。

## 麒麟服务器 V10 的 RPM 测试包

银河麒麟高级服务器 V10 使用 RPM/DNF，DEB 不作为其安装入口。保留现有 Linux x64 构建，在 Linux 主机准备好相同运行时后，显式选择 RPM：

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR="<python-runtime-directory>" npm run desktop:pack -- --linux rpm --x64 --publish=never
```

构建机需要 `rpmbuild`（Ubuntu 构建机的 `rpm` 软件包）。RPM 依赖与压缩配置由 `platform-profile.mjs` 提供；不转换 DEB，也不改变默认 DEB 目标。

`Linux x64 test package` 工作流的手动输入 `build_rpm=true` 会在原有 DEB 验收后，使用同次 Linux 构建的 `linux-unpacked` 原生生成 RPM，记录 SHA-256、依赖与安装脚本，并在 Rocky Linux 8 容器检查 RPM 安装、系统动态库、内置 Node/Python、桌面入口与卸载。此容器检查没有启动完整图形应用，不代替麒麟 VNC 实机、沙箱、中文绘图、PDF 和内网模型验收。

安装验证由独立可复用的 `Linux RPM installation validation` 工作流执行，先核对原始 RPM 的 SHA-256，再验证并记录镜像摘要与 glibc 版本。需要重跑验证时，在 `Linux x64 test package` 手动填写原构建的 `validate_rpm_run_id` 即可使用相同 artifact，无需重新构建；验证记录独立输出为 `transportx-linux-x64-rpm-validation`。管道保留容器失败退出码，并要求实际输出通过标记。

目标机先核对哈希并执行 `rpm -Uvh --test <package.rpm>`；缺少依赖时准备匹配麒麟版本的离线 RPM，不使用 `--nodeps`。依赖满足后由管理员安装，再由 VNC 桌面普通用户启动 `transportx-agent`。不得以 root 或 `--no-sandbox` 启动应用。RPM 测试包不上传官网或正式更新源。
