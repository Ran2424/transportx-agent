# CAD 模块接入与开发验收

## 范围

首版支持用户与 Agent 共同查看 2D DXF：用户选区并显式附加，Agent 查询、修改已有实体或新增标注，Host 提交新修订后更新同一标签。没有前端直接绘制/保存、DWG、道路等距偏移或工程审定能力。Windows 与安装包验收后置。

## 领域边界

| 部分 | 负责 | 权威 |
|---|---|---|
| Module / Extension | 按需开放工具、结构化请求与结果 | 冻结 Session Plan、生成 Tool Contract |
| Canvas | 呈现生命周期、标签、显式上下文 | 呈现事件与本轮 Context ID |
| CAD Host | 文件范围、版本、哈希、提交与恢复 | DXF 与修订 manifest |
| Python | 在作业目录执行几何操作、转换、检查、导出 | 不自行发布 revision |
| CAD Workspace / Viewer | 浏览、图层显示、临时选区与视野 | 不持有另一份可写几何权威 |

复用既有 Module 装配、Pi Registry、Host Client、PythonRunner 和 Canvas Adapter。官方可选 CAD 随应用提供受信任前端和 Python 依赖，并不等同于任意 ZIP 可注册 Host 服务或前端代码。

## 数据流与版本

1. 工作区或 canvas_present 打开 DXF。首次打开保留原始字节为受管 r1，不重写实体；相同源路径映射稳定 fileId。之后重新打开显示该图纸当前版本，不生成修订。源文件在快照后被外部改变时，要求显式作为另一图纸导入。
2. 用户选区并附加 Canvas，Host 根据受控资源保存哈希和内容 revision。连续鼠标、缩放和图层显示不写入对话。
3. Agent 读取本轮 Context。cad_inspect(contextId) 只分页查询选中实体；cad_draw(kind=edit, contextId, operations) 由 Host 解析冻结的基础版本。
4. 附加选区是参考信息，不限定 Agent 编辑范围。按任务可使用 handle、图层、区域 selector。提交回执通过模型可读 content 返回完整 drawing.fileId/revision/sha256；后续显式传 fileId、baseRevision、expectedSha256，可在原选区仍绑定 r1 时继续 r2 → r3。旧 contextId 作为固定版本目标时仍拒绝过期写入。
5. Host 在执行前后核对输入，Python 只写临时产物；DXF 审计通过后提交 manifest。每次内容修改产生新 revision，历史不覆盖；Canvas focus/update 不自行增加 CAD revision。显式打开旧 rN.dxf 使用独立历史视图，保留该版本的单位与哈希。
6. 同一标签显示新内容，保留视野和图层显示；旧选区失效。SDK 打开/激活串行，文档缓存包含 sessionId、viewId、revision 和 sha256，迟到请求不替换其他会话。

单位未知允许查看，编辑需明确米或毫米。GeoJSON 转换必须声明真实 sourceCrs 与米制投影或本地变换。move/copy 使用图纸轴向和单位；CAD 修改不隐式更新 GIS 或其他关联实体。

## 克制实现

- 提交仅强制重新打开、审计与数量上限；完整几何检查由 cad_verify 按需执行，默认 basic，traffic-v1 显式应用交通图层规则。
- 修改不默认生成 PNG/PDF。cad_verify(exportPreview=true) 对已有版本导出，缓存路径按 DXF 哈希确定，不产生新图纸修订；新图也可显式 exportPreview。
- manifest 是图纸谱系，Pi JSONL 是对话历史，执行回执用于重复保护，临时 commit journal 只用于中断确认，完成后清理。没有通用事务/任务/事件框架。
- Skill 首页保留入口、流程、必要约束和参考索引，编辑/转换/导出/交通/运行时细节按需加载。工具不包含操作系统分支；字体从实际资源发现，平台入口仍由 platform-profile.mjs 管理。

## 开发验收

2026-10-24，在 macOS arm64 开发环境完成以下验证；没有进行 Windows 或安装包验收。测试预算保持 40 个 Node 节点，新增断言并入既有场景。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 全部通过 |
| `npm test` | 40/40，实际注册预算通过 |
| `$TAU_PYTHON_COMMAND -m unittest discover -s test/cad -p 'test_*.py'` | 7/7 |
| `npm run test:web` | 既有 Web 全流程通过 |
| `TRANSPORTX_TOOL_SMOKE_PHASE=cad node scripts/tool-host-smoke.mjs` | 真实 Pi 0.80.10 / Host / Python / Chrome 通过；工具选择由脚本控制 |

CAD 1.3.0 集成确认：默认首请求仅五个基础工具、可选模块选择与批准契约、图纸与显式 PNG/PDF 导出、选区限定查询、修改与新增标注、过期版本拒绝、选区外编辑与同轮连续提交、用户和 Agent 复用图纸、同名同 revision 跨会话隔离、原执行查询、修订后视野/图层保留、点选/框选/平移顶部工具栏、重新读取图纸、图层显隐、空白清空、双标签单 Viewer 和三主题白纸；浏览器 pageErrors 为零。Node 场景另覆盖未知单位只查看、明确单位后编辑、源文件不被覆盖及旧 revision 独立查看。

- 类型检查与完整 Node 场景：契约、版本、哈希、选区、新增标注、重复调用、提交中断及恢复。
- Python 场景：CRS、单位、变换、几何操作、显式交通规则和按需导出。
- Web 既有回归：Document、Geo、Citation、任务切换和主题。
- CAD 集成：真实 Pi / Host / Python / Chrome，模型工具选择由脚本控制；覆盖工作区和 Agent 打开同一图纸、选区查询/编辑/新增标注、过期拒绝、多标签和跨会话隔离。

开发通过不代表 Windows 或安装包验收通过，本轮不出安装包。

## 会话中断与工具信息传递回归（2026-10-24）

- 模型接入独立保存 contextWindow 与 maxTokens；真实 Pi ModelRuntime 对 1M 输入窗口和 32,768 输出预算的配置与 Provider 请求传递已验证。单次输出达到上限与输入窗口用尽分别处理，不因发生 length 改写用户的 1M 配置。
- length 进入共享失败反馈与 Host 日志；只有推理没有正文时仍显示错误，历史恢复后可见。继续按钮准备核对已有成果的续写草稿，不重放原用户请求或已提交工具。
- CAD inspect 的 summary、完整哈希、drawing、按需实体及分页字段进入模型可读 content；draw 回执给出连续编辑信息。真实 Pi 到 Provider 的后续请求核对字段，不只验证 UI details。
- 查询审视：Canvas inspect 原本完整返回 JSON；动态工具的命名 inspect 改为完整 Schema（保留 anyOf 等嵌套定义）；CAD inspect 修复摘要吞详情；Module Authoring 1.2.2 去掉检查结果中途截断 JSON。Citation 的引用标记/来源 ID、Spatial 的状态/成果路径回执保持原有有界语义；Geo 没有独立 inspect 工具，不扩增工具。
- Tool Activation 1.0.1 沿 Pi 原生 Registry，首请求仍五工具；enable 后返回工具摘要与相关 Skill 路径，完整工具 Schema 在下一次模型请求开放。Host 补模块本地化描述，命名 inspect 可查参数；不要求模型逐个读 Skill、源码或 contract 文件。初始化预注册、冻结成员、版本、reload 与分支恢复仍沿既有规则。
- 不修改 Python 运行时选择、能力健康门禁或模型视觉配置；不执行 Windows/安装包验收，不声称真实云模型自主决策验收。
