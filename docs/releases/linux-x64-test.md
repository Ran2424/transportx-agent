# Linux x64 测试安装包

目标为统信 UOS V20 专业版 1070、兆芯 KX-U6780A（x86_64）、glibc 2.28。包格式为 DEB，当前为适配测试包，尚未通过 UOS 实机验收或厂商兼容认证，不上传官网或正式更新源。

## 构建与验证

在 Linux x64 主机上准备自包含 Python 3.10 runtime，安装 `desktop/python-requirements.txt` 的全部依赖，再执行：

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR="<python-runtime-directory>" npm run desktop:pack -- --publish=never
```

Linux 不要求 macOS/Windows 代码签名凭据；构建流程仍检查主机与 Python 架构、Python 版本及必需模块。基础包不含可选 Video Capability 的 ffmpeg。

GitHub Actions 的 `Linux x64 test package` 工作流使用 Ubuntu 22.04 x64，下载固定版本和 SHA-256 的可重定位 Python，执行类型检查、桌面契约测试，并安装实际 DEB 后运行桌面冒烟和卸载检查。工作流产出安装包、SHA-256 和 `linux-x64-validation.txt`，其中记录 CI 系统和包内 ELF 引用的运行库版本。这些检查不等于 UOS 验收；若运行库要求高于 glibc 2.28，不能交付为该目标机的可用版本。

## 目标机验收

1. 核对 SHA-256 后，通过 UOS 软件包安装器安装 `TransportX-Agent-<version>-linux-x64.deb`；单位受管终端由管理员按准入策略安装。
2. 使用普通用户从应用菜单启动 TransportX Agent，核对工作台、设置、任务目录与模块列表。
3. 配置单位允许使用的模型接口，验证创建任务、文件分析、地图与报告导出；断网场景还需核查模型、底图及联网功能。
4. 关闭应用后确认 Host 退出，再验证重启与卸载；保留用户任务资料。

不要为启动应用替换系统 glibc、关闭沙箱或使用 root 运行。遇到动态库或沙箱错误时保留终端输出，按具体系统环境修复。
