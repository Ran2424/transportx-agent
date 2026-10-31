# Tool 与插件架构优化：P0 执行记录

> 2026-10-22；基线 `12d6d209db380f95396f3eafa174140c02375c78` / TransportX 3.23.1 / Pi 0.80.10。  
> 状态：P0 门槛通过，PR #75 已合并；macOS / Windows / Ubuntu CI 均通过。不声明跨重启执行恢复。
> 范围依据：[冻结的 PLAN](<Tool 与插件架构优化 PLAN.md>)。本文更新执行证据及落实状态，不扩大公共框架。

## 1. 本轮交付与门槛状态

| P0 交付 | 当前证据 | 状态 |
|---|---|---|
| 信任入口及例外 | 原生确认/Host 接受记录、目录/ZIP 拒绝及保留旧版本、恢复/显式入口核对；生产 Pi 自动发现及 reload 否定探针 | 本机及三平台 CI 通过 |
| Spatial 状态归属/提交 | Extension 是模型适配；Host/Python 执行，校验结果后写 manifest；引用登记在提交返回后独立处理 | 源码核对完成，取消/断开/崩溃窗口待实测 |
| 持久 Owner | `spatialOwner` 验证受管文件、header.id、header.cwd 与当前 cwd/计划 workspace；复制历史得到不同 owner | 身份校验通过；P3 绑定实际查询权限 |
| Pi 行为基线 | 真实 Pi + 生产 Host 验证错误 `isError`、execute AbortSignal、首工具前 header 落盘、历史读取及 reload | 本机通过 |
| 性能基线 | 改造前 main 与当前生产路径各五次，固定本地 Provider、11 模块/18 工具 | 小工具基线通过；阶段性领域/大结果测量后续补充 |

本轮新增脚本仅在临时目录检查依赖行为，不修改产品运行逻辑、用户模块、真实会话或凭据，不注册额外 Node 测试节点。

## 2. 信任入口核查

| 入口/事实 | 源码依据 | P0 落实要求 |
|---|---|---|
| 目录安装直接调用 install，再启用 | [模块 RPC](../src/server/rpc-handlers/module.ts)、[设置界面](../src/web/platform/settings/SettingsDialog.tsx) | 安装/启用不能只凭 Agent 提交的参数认定用户已信任；明确用户授权的具体包与范围 |
| ZIP 有预览与信任提示，安装 RPC 自动启用所选模块 | 同上；[Installer](../src/server/module-installer.ts) | 预览提示不等于后端能证明授权；拒绝绕开实际用户决定的自动执行路径 |
| 启动器将项目/计划入口作为显式 `--extension` 传给 Pi | [启动装配](../src/server/session-pi-launch.ts) | 在交给 Pi 之前检查来源/授权，安装不是唯一检查点 |
| 全局/项目资源和 reload 由 Pi 资源加载机制处理 | Pi 安装包 `dist/core/resource-loader.js`、`dist/main.js`、`dist/core/project-trust.js` | 保留并核对 Pi 已有 project trust，不能假设它覆盖所有来源；写入自动发现目录不应绕过平台工作流 |
| 原生 bash/write、已信任 Extension 仍有本机代码能力 | Pi 原生工具及 [Pi 子进程启动](../src/server/sessions.ts) | 授权入口是产品工作流约束，不声称对恶意本机代码形成隔离 |

Pi 0.80.10 的 project trust 解析之前会加载全局及显式 CLI Extension；`--no-extensions` 禁用自动发现，显式 `-e` 仍加载。实际探针使用 `--no-approve --no-extensions --extension <临时文件>`，Extension 只写临时标记，结果仍为已执行。这是 Pi 的显式加载语义，不将其定性为 Pi 漏洞；TransportX 需在自己的显式入口落实用户决定。

授权决策沿用 PLAN ADR-T01：制作不是安装/运行授权；用户可一次明确接受具体包的安装、启用、样例测试及后续运行，已有覆盖范围内不重复确认。内置例外以平台受控来源确定，普通包的 ID/标签不能自证。静态包检查不执行 Extension；动态样例测试也须核对授权。

**下一项门槛工作**：在现有桌面/Host 入口中选定最小用户决定传递方式，覆盖目录、ZIP、启用、恢复及非 UI 显式注入；用未授权标记 Extension 证明未加载/未执行。尚未选定或实现该方式，不把信任提示、安装 API 的布尔参数或代码生成成功计为通过。不为此新建插件 Runtime、权限 DSL 或通用沙箱。

## 3. ADR-O01：Spatial 持久 Owner 决策

### 标识与建立者

复用已有 Pi 持久会话及受管历史文件，Owner 是两个现有信息的组合：

`{ historyKey: 相对 SESSIONS_DIR 的规范化 POSIX 历史文件定位, piSessionId: Pi session header.id }`

这不是新增用户身份系统或新的随机 ID。Pi 建立 header；Host 从自己管理的活动会话取得 sessionFile，以现有受管路径校验解析文件并读取 header，再建立执行记录关联。模型、Extension 请求中的 owner 字段不能覆盖这个结果。

选择依据：

- [PiRpcSession](../src/server/sessions.ts) 恢复时重建 live ID，因此它不适合作为持久 Owner。
- Pi `SessionManager.open()` 保留 header ID，fork 创建新 ID；直接复制 JSONL 也保留旧 ID，单独使用 header ID 会混同副本。
- [workspace-owner.json](../src/server/session-workspace.ts) 只有 workspace/parent 等路径信息，用于目录删除检查，没有稳定任务 ID。
- `citationRegistryId` 可从工作目录已有注册表恢复，是 Citation 归属，不用作全部 Spatial 执行的权限身份。

### Host 的最终检查（待实现，P3 前必须验证）

1. 先验证当前活动会话、停止状态、有效 service token、计划内 Spatial 能力及当前资源授权，不把 ownerKey 当 bearer token。
2. 使用 [resolveSessionFile/containedFile](../src/server/server-main.ts) 的受管路径边界解析 Host 已知文件，校验扩展名、文件存在性/类型及规范路径；historyKey 由 Host 计算，不接受模型提供的路径来决定 Owner。
3. 校验 header.id 非空，并确认 header.cwd、当前 session.cwd 与持久计划 workspace 的规范目录一致。当前 resume 可接收 cwd 输入，受保护执行不能把该输入直接当作归属证明；不一致拒绝或走明确迁移，不能静默回退。
4. 新会话尚无落盘 header 时，Owner 不能视为已建立；需先通过 Pi 的受支持写入/首条 assistant flush 确认，再接受需要持久重复保护的操作。Host 不直接改写 Pi JSONL 补身份。首个真实工具调用前的 flush 时序仍须测试。
5. 查询旧 Invocation 重新派生当前 Owner 并严格匹配记录，重新验证资源权限；不能只因持有 operationId、cwd 相同或历史文本含旧 ID 就返回结果。

### 恢复、分支与复制规则

| 场景 | Owner / 旧 Operation 规则 |
|---|---|
| 同一受管历史文件恢复、Host/Pi 重启 | 定位与 header ID 都一致且当前授权有效，才可查原执行；live ID/token 重新建立 |
| 同一文件内切换分支 | Owner 不变，可按当前授权读取结果；自动关联旧重试仍须有原操作可信关联及当前分支证据，不从相似参数推断 |
| Pi fork/new，或复制到另一历史文件 | 新定位或新 ID，视为不同 Owner；不能继承旧 operationId 的重复保护/查询权限 |
| 工作目录相同的另一会话 | 不自动共享 Invocation，受管成果若需共享走独立授权读取路径 |
| 历史文件改名/移动、跨机器导入 | 默认不匹配原 Owner；如未来需要迁移，显式验证来源与重绑定，不模糊匹配文件名/内容 |
| 旧记录缺少可验证的 Owner 信息 | 不自动认领，不借 Citation ID 或 cwd 推断可重试；保留产物并说明无法确认 |

以上是决策，尚不是授权实现。跨副本/跨 cwd 查询拒绝、分支重试关联、旧会话迁移及首个工具的落盘时序均需进入 P3 前置测试。

## 4. 实际检查与结果

可重复入口：

```bash
rtk npm run test:pi-smoke
rtk proxy node scripts/tool-p0-probe.mjs
```

- `test:pi-smoke`：server 构建通过；测试预算 40/40；真实 Pi + 本地固定 Provider 验证 Bridge、Task command、拒绝 ACK 和 steer/follow-up 顺序通过。该 smoke 显式 `--approve`，不能证明未授权加载被拒绝，也没有覆盖真实 Spatial Host 路由。
- [tool-p0-probe.mjs](../scripts/tool-p0-probe.mjs)：无模型调用；新 Session header 起初未落盘，assistant flush 后存在；同文件 branch/reopen 保留身份；fork 改变 ID；原始文件副本保留 ID 但定位改变；拒绝 project trust 仍加载显式 Extension。临时进程和文件在结束后清理。
- 机器：Apple M4，10 核，24 GiB，Darwin 25.5.0 arm64，Node v24.2.0，Pi 0.80.10。初次临时探针及两次脚本执行的 CLI spawn→get_state 分别约 477/469/440 ms；未控制冷/热缓存，也未经过生产装配，不能当作生产性能预算或尾延迟。

尚未执行：Spatial 真实取消/提交丢响应/Host 强杀、信任门禁否定验收、真实 Agent 制作三个用例、发布包与跨平台验证、生产启动/内存/恢复性能基线。不能把固定 Provider 或依赖层探针当作这些场景已通过。

## 5. 原 P0 剩余工作顺序（下节补充落实证据）

1. 落实并验证信任入口硬门槛，包含样例测试与显式/自动发现路径；内置例外和已有用户授权范围有证据。
2. 验证 ADR-O01 的 Host 文件/cwd/计划检查和首个工具前的持久归属时序；固定分支/副本拒绝用例。
3. 补 Pi Tool 错误与 signal 的实际事件/历史基线；记录 Spatial 结果与 manifest 的提交边界，不在 P0 提前建设持久 Invocation。
4. 用同一硬件/数据建立生产基线、原始样本与对应 PR 的允许退化范围；退出表全部通过后开始 P1。

## 6. 开发基线与 P0 实现证据

已有 Citation 工作通过 PR #73 合入 main；原工作区全部规划/P0 文件通过 PR #74 保存，包含尚未实施的交通仿真规划。由最新 main 创建 `codex/tool-plugin-plan`，没有 reset、强推或删除已有成果。基线全量 typecheck、40/40 测试、真实 Pi RPC 和 Web smoke 通过；Web 首次 Geo reload 超时，完整复跑通过。#73 的 Windows CI 暴露既有目录复制 `EEXIST`，P0 同步修复，不把 macOS 通过计作 Windows 通过。

实现：`module-trust.ts`、现有 Module RPC/Session 启动与 Electron Supervisor。原生确认明确展示来源、入口、依赖、本机文件/网络权限及尚未核实的访问要求；只由父进程 IPC 决定，未开放接受信任的 HTTP/RPC 接口。平台受控目录才有 builtin 例外。已接受包内代码允许编辑，入口/依赖/版本/目录变化重新确认；恢复重新核对当前声明，卸载撤销记录。无桌面通道的未接受包被拒绝，需先在桌面完成确认。数据/知识包也按同一范围核对，避免 Skill 成为执行脚本的隐式授权。

静态 Installer/Registry 不导入 Extension；安装后、启用前请求接受；拒绝清理本次版本并保留全部旧版本。`desktop-launch.test.ts` 通过真实 Host 原始 RPC 验证目录/ZIP 否定、伪造 `trusted:true` 无效和更新回滚；测试父进程仅授权测试自己创建的临时包。`module-system.test.ts` 验证来源标签伪造、入口越界、声明变化重新接受与编辑兼容。此类测试模拟原生决定通道，不冒充真实人点击截图验收。

`scripts/tool-host-smoke.mjs`：生产 Installer/Assembly/Host + Pi 0.80.10 + 固定 Provider。五个新会话实际执行独立探针包；拒绝时标记文件不存在，安装阶段不执行代码；接受范围被复用。实际错误进入 `isError` 及 JSONL；实际取消触发 execute signal。首工具读取的 header 已落盘且 cwd 与当前任务相符。全局/项目未授权标记 Extension 在启动和实际 `ctx.reload()` 后均未执行。新增缺失 npm 包/恶意 `npmCommand` 否定用例曾发现 offline 仍执行全局 npm 路径查询；已补版本固定的依赖修正：关闭全部自动资源时跳过包发现（两个调用点），安装依赖与构建均应用，版本/源码不匹配失败。生产探针覆盖 reload 和随后新会话，确认命令标记未生成。此处仅为边界探针，用户业务脚本制作闭环仍按 P1/P4 单独验收。

`spatialOwner` 是后续 L3 的身份校验器，不是 Invocation 存储：仅接收 Host 会话文件，验证受管路径/文件类型、有界 header、非空 ID、canonical cwd 与计划 workspace；测试验证同文件分支/不同 live ID 保持归属、复制文件归属不同、越界和跨 cwd/计划被拒绝。原执行的查询/去重授权将在 P3 接入后测试，不能据此声称已经恢复旧作业。

Spatial 提交边界仍是：Python 输出 → Host 结构/路径/大小/哈希/GeoJSON 校验 → manifest 写入 → 返回后可选 Citation 登记；引用 warning 不回滚计算。P0 未改该提交路径，取消/丢响应窗口进入 P1，持久确认进入 P3；未知结果不得自动重跑。Geo scene/revision 继续归 Pi 分支所有。

性能对照使用同一 Apple M4/24 GiB、Darwin arm64、Node 24.2.0、Pi 0.80.10；串行、各五样本，固定 Provider、11 个模块/18 个工具，小探针结果。main 以独立临时源码快照构建 server，使用同一依赖；未清系统文件缓存，不称为冷启动。测量为创建会话 → 首次工具完成/历史及 Bridge 可读（含两次本地模型往返和一次显式 get_state），不是纯 HTTP 开销或原子 Registry 观察。

| 样本 | 改造前 main (ms) | P0 (ms) |
|---|---:|---:|
| 1 | 663 | 451 |
| 2 | 434 | 429 |
| 3 | 436 | 425 |
| 4 | 464 | 425 |
| 5 | 441 | 431 |
| 中位数 | 441 | 429 |

后续同条件启动预算：单样本 ≤1500 ms，中位数较基线增加 ≤250 ms；超出须定位/复测后说明。五个样本不足以声明稳定 p95；脚本的 harness RSS 约 100 MB，仅为探针进程，不是 Host/Python 峰值。P1 测 Spatial 输入/输出、摘要和取消资源清理，P2 对共性提取前后再比较；未测的大结果 RSS/跨重启恢复耗时不列为通过。

本机检查：全量 typecheck、40/40 测试、Owner/安装定向复验、真实 Pi Host 探针、Electron 桌面/PDF smoke。测试预算保持 40；未修改 Module 内容，不提升模块或平台版本。正式签名包、Windows 本机、P3 故障恢复及 P4 三个真实模型制作案例均未验收。

补充回归：Electron smoke 已贯穿生产 Host → Utility Process Supervisor → 主进程原生对话框调用，断言来源/入口/版本、默认取消、拒绝/接受和安装不执行代码；测试仅替换对话框返回值，不声称真人点击验收。Web harness 原先没有授权的固定模块被新门禁拒绝，已让 harness 显式接受自己创建的临时 fixture；不关闭生产启动核对。基线中 `--version` 和 HTML export 在 Pi 创建资源加载器之前返回，未发现这两条入口加载 Extension。

退出证据：[PR #75](https://github.com/Ran2424/transportx-agent/pull/75)、[三平台 CI](https://github.com/Ran2424/transportx-agent/actions/runs/39805309217)。合并后从最新 main 创建 `codex/tool-plugin-plan-p1`，后续证据见 [P1 记录](<Tool 与插件架构优化 P1 记录.md>)。
