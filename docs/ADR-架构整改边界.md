# ADR：架构整改的保证与限制

日期：2026-10-10。状态：本地实现；Windows 实机、真实上游故障和签名跨版本发布另行验收。基线及每项测试见 [执行计划](架构整改执行计划.md)。

## 选择

保留模块化单体、文件持久化和 Browser Kernel。配置读取与实例装配分开，Manager 接收具体依赖；不新增数据库、服务拆分、消息总线或验证库。现有 Geo 服务仍负责领域状态，未把本轮注入扩展为多租户或多 Host 平台。

认证只保证 Host 的网络入口和服务授权，不给可信 Module/Pi 基础工具增加 OS 沙箱。远程部署必须显式开启并配置认证；部署者自行提供 TLS。用户认证与会话服务 token 分开，服务 token 仅允许对应能力、会话与内部 POST 路由。

命令接收、消息交付和运行完成分开。超时是 unknown，保留上下文和账本等待事实确认；明确拒绝后使用新 ID。去重仅在同一 Host 的保留窗口内有效。Pi 0.80.10 回传文本而非原生 messageId；已测 steer 优先交付，任意插件改写仍需验证。

Snapshot 是当前分支的替换而非 append。Host generation 每次启动变化；revision 是 Host 内存序列。旧 Host 不提供相同排序保证，不能将其 revision 当作持久日志 offset。消息失败显示安全类别，编辑后重新提问仅恢复文本，由用户检查后提交。

## 资源策略

| 资源 | 允许根目录/版本 | 完整性与响应 |
|---|---|---|
| 会话 JSONL/历史导出 | 配置的 sessions；真实路径在根内，文件后缀受限 | 历史删除等待 Writer，越界 symlink 拒绝 |
| 普通工作区 raw/preview | 当前会话 cwd；最新内容 | realpath + 文件类型；nosniff，SVG/HTML sandbox CSP，不伪装成不可变引用 |
| Geo manifest/data/选区 | 当前会话 `.tau/geo` 中的 resourceId | 单次缓冲按 bytes + SHA-256 校验，校验后才处理 ETag；100 MB 上限 |
| Citation GET/HEAD | 注册的 cwd/选定 Knowledge 根，指定 citationId | 共用真实路径、版本校验；Markdown 保留既有最新内容及变化提示；SVG/HTML 主动内容受限 |
| Video | 选定资产根与当前任务的受控派生资源 | 沿用 manifest、归属、哈希及 byte-range 校验；本轮未修改格式 |

普通工作区读取和注册引用是不同语义；普通 URL 不可作为“已验证引用版本”的凭据。根内合法链接仍受 realpath 判界；检查和打开之间没有 OS 级不可替换文件锁，可信本地代码并发更换路径不在网络入口保证内。

## 写入与恢复

同一 Agent 根目录由 `host.transportx-lock/owner.json` 记录 pid/nonce。mkdir 原子取得租约；第二 Host 拒绝启动。模型更新另有文件租约和 Host 内队列，跨 await 不丢失同一 Host 的更新。不同 Agent 根目录指向同一任务目录、外部 Pi 直接写入暂不支持并发协调。

settings/models/附件索引以唯一 temp + fsync + rename 替换，上一份有效 JSON 写入 `.bak`。只对 missing 使用空默认；corrupt/unsupported 保留原件并拒绝写入。Pi auth/JSONL 由上游持久化，本项目不声称对它们提供原子备份。rename 失败可恢复原文件；该机制不是多文件事务，也不是所有文件系统的断电承诺。

恢复步骤：停止旧 Host、Pi Writer 与受管分析进程；备份整个用户目录和任务目录；核验 `.bak` 的 JSON 及业务结构后恢复对应文件。遗留租约先保全 owner 文件，在确认旧进程停止后移走锁目录，再重启。不要仅因 PID 不存在就自动抢租约；其后代进程可能仍在写入。恢复不自动删除损坏证据。

## 作业与诊断

每个受管分析作业具有 session owner、jobId、AbortSignal，关闭和请求断连等待取消。POSIX 使用独立进程组，Windows 使用 Profile 的 taskkill；Windows 实机仍需证明后代终止及文件句柄释放。未确认停止时保留注册/容量，不以成功删除掩盖停止失败。PDF 和 WS 容量独立验证。

共享 RPC envelope 在副作用前校验类型，领域继续使用已有解析器；保留 Pi 扩展字段兼容。不是完整的所有外部 DTO 迁移。JSONL 坏行允许部分历史恢复并发出诊断，非 ENOENT 读取失败不吞掉。Pi 非 JSON stdout/stderr 与消费者异常只记录安全代码/ID/计数；不透传正文、凭据和供应商原文。

诊断每个 reporter 至多 20 条（历史/命令 reporter 为 200 条），同一代码和关联 ID 去重；受管 job 失败关联 session/job，可靠 command 失败关联散列 session/command ID。桌面 Host 日志沿用 5 MB 截断，诊断不构成完整审计日志或外部监控。

## 平台与移除条件

平台事实唯一源为 `desktop/scripts/platform-profile.mjs`。构建生成 `bin/host-platform.json`，Server 与桌面共用；构建产物不入 Git。Linux 只保留 Web 开发操作，不成为桌面发布目标。安装器名称、静默参数、打开命令与进程树策略不在业务层重复声明。

若 Pi 提供稳定 messageId，则替换文本关联并保留历史兼容测试。若实际长历史基准证明需要窗口化，再设计焦点/滚动/可访问性回归。若需要多 Host 或第三方不可信 Module，先定义所有权与隔离协议，不能移除租约或宽化资源边界作为实现方式。
