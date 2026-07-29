# Pi Traffic Workspace 代码与架构审查报告

- 审查日期：2026-07-24
- 范围：`src/`、`extensions/`、`scripts/`、`test/`、构建配置及现有 `docs/`
- 结论依据：静态审查、依赖/构建链检查，以及 `npm run typecheck`、`npm test`（56/56）、`npm run test:react-smoke` 均通过。
- 优先级：P1 必须先处理；P2 应在近期迭代处理；P3 按实际规模或需求触发。

> 本报告不建议拆分微服务或重做前端。项目是本机 Agent 工作台，保持模块化单体是正确取舍；建议优先修复网络暴露、命令可靠性和资源上限。

## 1. 业务与当前架构理解

系统以 Pi 子进程为执行核心：三个内置 Extension 产出任务、地图和运行时桥接的结构化契约；Node 服务管理 Pi RPC 会话、JSONL 历史、会话目录权限和 HTTP/WebSocket；无框架的 Browser Kernel 将事件归一化为 store 状态；React 仅通过命令端口和 store 渲染对话、任务、文件和 GIS 工作区。

现有文档中的以下设计已在代码中落地：

- `src/contracts/` 是 Extension、Server、Kernel、React 共用的协议权威；契约不反向依赖平台代码。
- JSONL 分支投影是历史事实来源，浏览器只维护实时 overlay。
- 文件与 Geo 资源以 live session 的 cwd 为边界，`realpath` 和会话资源 ID 防御路径穿越。
- React 是唯一生产 UI，地图运行时按需加载；没有保留第二套 UI。

## 2. 项目整体架构评价

**总体评价：良好（模块化单体，边界大体清晰）。** `contracts → adapters → UI` 的依赖方向清晰，核心协议有运行时解析和跨层测试；会话隔离、Geo 声明式协议、任务状态机均避免了让 UI 解析自然语言或直接执行 Agent 输出。这是本项目长期可维护性的主要资产。

需要警惕的演进点有三类：

1. 服务默认网络边界与本机高权限能力不匹配；一旦部署到 LAN，风险不再是普通 Web UI 风险。
2. WebSocket 当前只是“尽力发送”，但承载 prompt、abort 和 Extension UI 回答等业务命令，缺少交付/重连语义。
3. React 迁移后仍保留一套已生成的 Browser/Geo 构建物，生产入口与发布物出现重复，容易形成双份实现和无谓包体。

未发现 `src/`、`extensions/` 内明显循环依赖；当前的共享契约、handler 分拆、Kernel 与 React 分离不应为追求形式化而重构。

## 3. 高优先级问题（P1）

### P1-1 默认对所有网卡监听，且未配置凭据时完全匿名

- **位置**：`src/server/config.ts:40`；认证启用条件见 `src/server/server-main.ts:34-45`。
- **当前问题**：默认 host 为 `0.0.0.0`，而 `TAU_USER`/`TAU_PASS` 均为空时 `AUTH_CONFIGURED` 为 false，服务直接放行。该服务可以创建 Pi 子进程、向 Agent 发送 prompt、读取会话 cwd 文件、在本机打开文件。
- **影响**：同一局域网、错误的端口转发或不可信反向代理环境中的访问者可取得本机 Agent 工作区控制能力，并造成数据泄露、任意 Agent 操作及资源耗尽。README 写的是默认 `127.0.0.1`，与实际默认值不一致，放大误用概率。
- **推荐方案**：默认监听 `127.0.0.1`；只有显式 `--host 0.0.0.0`/非回环 host 时才允许 LAN 暴露，并要求已配置认证（或显式、不安全的确认开关）。启动日志应醒目提示暴露地址与认证状态；同步修正 README。
- **验证**：新增启动配置测试：无凭据的非回环监听被拒绝；默认值为 loopback；显式 LAN + 凭据可正常启动。

### P1-2 关键交互命令在断线时被静默丢弃

- **位置**：`src/public/websocket-client.ts:123-129`；`src/public/kernel/commands.ts:189-217`；现有任务文档也在 `docs/TASK_MODE_INTERACTION_PLAN.md:411` 标注 pending interaction 重连恢复未实现。
- **当前问题**：`WebSocketClient.send()` 在非 OPEN 状态仅 `console.error`，不返回失败；调用方仍立即写入 optimistic prompt，或在 `extensionUi.respond()` 后把 dialog 标为已解决。重连没有 outbox、交付确认或 pending Extension request 的服务端快照。
- **影响**：网络抖动期间，用户看到消息已发送但 Pi 从未收到；用户回答可能被 UI 清除而 Pi 永久等待。对任务模式而言，这是可导致任务卡与实际 Agent 状态分叉的核心稳定性问题。
- **推荐方案**：最小修复先让 transport `send` 返回成功/失败并在未连接时抛出可展示的 `AppError`，只在成功写入后更新 optimistic/resolve 状态。随后为有副作用命令加入 client command ID 与服务端确认；只对幂等的 UI response/控制命令维护有界 outbox。对于 pending Extension UI，将请求 ID 与会话关联后纳入 live snapshot 或提供查询端点，重连后重新入队；服务端拒绝过期和重复 response。
- **验证**：模拟 OPEN→CLOSED 的 prompt、`extension_ui_response`、重连和重复提交；断线时不得产生 optimistic 成功状态，重连后同一 request 至多提交一次。

### P1-3 请求体超限后仍继续累积数据，且未中止连接

- **位置**：`src/server/server-main.ts:78-84`。
- **当前问题**：超过 20 MiB 时 Promise 会 `reject`，但 `data` 监听器继续把后续 chunk 拼入字符串；请求流没有 `destroy`/drain 标记，也未依据 `Content-Length` 预检。
- **影响**：攻击者或异常客户端可以持续上传，造成 Node 主线程内存和 GC 压力；与默认匿名 LAN 暴露组合后风险更高。
- **推荐方案**：使用字节数而非字符串长度计数；首次超限即移除监听/`req.destroy()`，确保只结算一次；可先拒绝超限的 `Content-Length`。统一返回 413，而不是将所有 route 解析错误视为 400。
- **验证**：分块发送超过阈值的 body，断言连接被停止、返回 413、解析函数不再保留后续 chunk；补充无 `Content-Length` 情况。

### P1-4 没有 live Pi 会话配额与创建并发上限

- **位置**：`src/server/api-routes.ts:35-47`；`src/server/sessions.ts:610-617`（创建后直接加入 `sessions`）。
- **当前问题**：每个创建请求都会 spawn 一个 Pi 子进程；没有最大 live session 数、创建队列、启动超时后的容量保护或每客户端限流。
- **影响**：误点、脚本循环或未认证网络访问会快速耗尽进程、文件描述符、模型配额和内存，并使正常会话不可用。
- **推荐方案**：配置一个保守的 `maxLiveSessions`（本机默认即可），对 create/resume 建立全局并发启动上限；达到上限返回明确 429/503。容量计数须覆盖“正在启动但尚未加入 Map”的会话，并在失败/退出时释放。
- **验证**：并发创建超过上限时，最多 spawn 指定数量；失败、关闭、子进程退出后容量可恢复。

## 4. 中低优先级优化建议

### P2-1 历史列表和搜索为全量串行 JSONL 扫描

- **位置**：`src/server/session-history-handler.ts:132-187`。
- **当前问题**：列表逐文件顺序流式解析整个 JSONL；搜索也逐文件、逐行读取，直到累计 30 个结果。每次打开侧栏/搜索均重复扫描，且局部异常被静默跳过。
- **影响**：随着 Pi 历史积累，单个 HTTP 请求会占用 I/O 与事件循环，侧栏和搜索延迟不可预测；损坏文件会悄悄从结果中消失，难以诊断。
- **推荐方案**：先记录真实会话数、文件大小和 P95 延迟；超过阈值后引入以内存为主、按 mtime 失效的元数据索引（id、cwd、标题、最近对话时间），搜索再考虑增量索引。保留按需读取完整 branch；不要引入数据库。对跳过文件至少计数并在开发诊断中暴露。
- **优先级**：P2（当前架构文档已明确这是按规模触发的优化，方向合理）。

### P2-2 React 生产入口与遗留 `public` Geo 构建重复

- **位置**：`package.json:40-44`、`src/web/features/geo/GeoWorkspace.tsx:104`、`src/public/visualization/geo/geo-runtime-entry.ts`。
- **当前问题**：React 经 Vite 动态 import 该 runtime，生成 `dist/web/assets/geo-runtime-entry-*.js`（构建实测约 1,039 kB、gzip 277 kB）；同时 `build:geo` 又把相同入口 bundle 到 `public/geo-runtime.js`（构建实测约 1.5 MB）。Node 静态服务只提供 `dist/web`，React 路径不会消费后者。
- **影响**：每次 build 额外耗时，npm 发布物携带未使用的大文件；两个构建链若日后配置分叉，会产生难以察觉的运行时差异。
- **推荐方案**：确认没有外部/legacy 消费 `public/geo-runtime.js` 后，删除 `build:geo`、其发布文件和相关旧说明；保留 Vite 的动态 chunk。若确有第二消费者，则将 runtime 打包规则收敛为单一明确入口，而不是双编译。
- **优先级**：P2。该项是收敛已迁移遗留物，不是重写 Geo runtime。

### P2-3 `server-main.ts` 仍承担过多策略和领域逻辑

- **位置**：`src/server/server-main.ts`（认证、body 解析、session file/export path、RPC command 分发、CORS、组装与 CLI 生命周期）。
- **当前问题**：文档规定其只做认证、RPC 和装配，但文件同时持有路径安全策略与大量 `handleRpcCommand` 分支。新增命令或权限规则会继续聚集在 composition root。
- **影响**：单元测试需要导入整个 server singleton，安全规则与会话命令难以独立替换/验证；未来扩展 auth、命令幂等和配额时冲突增多。
- **推荐方案**：不做大规模重构。结合 P1，将纯函数/依赖注入的 `request-body`、`session-path-policy`、`rpc-command-service` 逐项提取；`server-main` 只保留依赖装配。每抽取一项迁移对应测试。
- **优先级**：P2。

### P2-4 测试治理文档与实际基线不一致，并以测试数量设硬上限

- **位置**：`docs/TEST_BASELINES.md:5,14`、`docs/ARCHITECTURE.md` 演进规则第 2 条、`docs/REACT_UI_MIGRATION_PLAN.md:16`。
- **当前问题**：文档声称默认测试固定 49 项，但本次 `npm test` 实际为 56 项；“不超过 50 项”的规则也已失效。项目虽已有质量很高的单元/集成/浏览器 smoke，但数量配额会阻碍为 P1 风险补回归测试。
- **影响**：维护者无法从文档判断真实质量门槛，且可能为了满足数量而删除仍有效的覆盖。
- **推荐方案**：删除固定数量限制，改为风险覆盖清单与执行时间预算，例如：默认测试须覆盖协议、权限、状态转换和恢复；浏览器/Pi smoke 在发布前运行。更新实际 56 项或不再记录易过期数字。
- **优先级**：P2（文档治理，不影响当前功能）。

### P3-1 Geo resource 的 manifest SHA-256 未在读取时复算

- **位置**：`src/server/geo-resources.ts:69-96`；现有设计文档 `docs/GIS_WEB_VISUALIZATION_TECHNICAL_PLAN.md:590` 已明确承认该边界。
- **当前问题**：读取时校验 resourceId、hash 格式和 bytes，但不会校验 data 文件内容是否仍匹配 manifest hash；同大小篡改无法被发现。
- **影响**：本机任务目录被其他进程改写时，浏览器可能展示与声明资源不一致的数据。
- **推荐方案**：不要在每次 GET 同步重算 20 MiB 文件 hash。若完整性成为实际需求，发布后将资源设为只读并在首次读取/mtime 变化时异步或缓存校验；失败返回 409。先补篡改 fixture。
- **优先级**：P3；当前是本地可信工作区，成本不应高于收益。

### P3-2 代码小型债务：重复分支与宽泛静默 catch

- **位置**：`src/public/websocket-client.ts` 的重复 `break`（约 146、153 行）；`src/server/session-history-handler.ts:149,181` 等。
- **当前问题**：存在迁移残留的不可达语句；历史解析对单文件/单行异常普遍静默忽略。
- **影响**：前者降低可读性，后者降低运维可观测性。
- **推荐方案**：随 P2-1 一并删除重复语句；保留容错读取，但累计 `skippedFiles`/`malformedLines` 并以诊断字段或 debug 日志输出，避免把用户数据问题伪装成“没有历史”。
- **优先级**：P3。

## 5. 推荐重构路线（收益/成本排序）

1. **收紧运行边界（高收益、低成本）**：默认 loopback；LAN 必须认证；修正 README；为 body 限制和 session 容量增加测试。先解决 P1-1、P1-3、P1-4。
2. **补齐命令可靠性（高收益、中成本）**：transport 显式失败 → optimistic 状态延后 → command ID/确认 → pending dialog 重连恢复与去重。以 P1-2 的测试矩阵作为验收，不引入通用消息队列。
3. **收敛构建发布物（中收益、低成本）**：确认无消费者后删除废弃 `build:geo`/`public/geo-runtime.*` 产物路径，更新 GIS 历史方案中已过时的构建描述；对 Vite Geo chunk 设体积预算并只在超标后拆包。
4. **按指标优化历史（中收益、中成本）**：先增加请求耗时、扫描文件数和异常计数；达到阈值再加入 mtime 失效的内存索引。保持 JSONL 为事实来源。
5. **渐进提取 Server 策略（中收益、中成本）**：只在改动相关领域时提取 body/path/RPC service，不进行一次性目录重排。
6. **修正文档治理（中收益、低成本）**：以本报告与 `ARCHITECTURE.md` 为当前基线，更新测试文档和已归档方案的状态说明；避免用测试数量限制代替风险覆盖。

## 6. 不建议修改的合理设计

1. **不拆微服务/多仓库**：本项目是本机 Pi 工作台，部署和状态均强依赖本机进程、文件系统、JSONL；模块化单体的运维成本最低。
2. **不引入 Redux、React Query 或全局状态框架**：Browser Kernel 已实现 transport、normalizer、dispatcher、store 和 command ports 的明确边界，React 没有直接解析 RPC。
3. **不把 JSONL 换成数据库**：当前文档已经给出“延迟可观察后再建索引”的正确策略。数据库不会替代 Pi JSONL 的会话事实来源。
4. **不把 Agent 生成的地图开放为任意 MapLibre/JavaScript**：现有 `GeoScene` 声明式白名单、资源 ID 和运行时校验是安全且可扩展的抽象。
5. **不提前为第二地图引擎或 Taskflow 建适配层**：尚无第二实现者；当前 Extension→契约→React feature 已足够支撑真实需求。
6. **不把 `sessions.ts` 的 Pi 生命周期强行拆碎**：该文件虽较大，但子进程启动、RPC 关联、投影与关闭生命周期具有高内聚；应先处理配额和可观测性，只有出现第二种 session runtime 时再拆分。

## 7. 审查限制与后续验收

- 本次未连接真实外部交通数据库，也未运行 `test:pi-smoke`，因此不对第三方模型、真实 Pi 版本差异和真实数据查询性能作结论。
- `npm test` 的 Node 对 TypeScript 源文件报告了 Node 的 experimental type-stripping / `MODULE_TYPELESS_PACKAGE_JSON` 警告；构建与测试均成功。这是工具链整洁性信号，建议在下一次 Node/TypeScript 升级时单独评估模块类型声明，不建议为消除警告立即切换整个包的 ESM/CJS 模式。
- P1 修改完成后，应至少重新运行 `npm run typecheck`、`npm test`、`npm run test:react-smoke`，并新增 LAN 鉴权、断线交互、超限 body 和会话配额回归。
