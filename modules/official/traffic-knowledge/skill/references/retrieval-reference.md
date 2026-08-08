# 检索与引用参考

## 目录

1. 数据入口
2. 分类与优先级
3. 脚本接口
4. 查询设计
5. 结果字段
6. 引用与复核

## 1. 数据入口

默认知识库根目录：

```text
由运行时环境变量 `TRANSPORTX_KNOWLEDGE_ROOT` 指定的 Knowledge 模块资产目录
```

`search_knowledge.py` 根据脚本自身位置解析 `<skill-root>`，因此移动或分发整个 Skill 后无需修改路径。

全局入口：

- `_catalog/documents.jsonl`：文档、分类、状态、目录和知识数量；
- `_catalog/taxonomy.yaml`：正式标签；
- `_catalog/aliases.yaml`：查询同义词；
- `_catalog/INGESTION_REPORT.md`：解析方式、验收与限制。

单文档入口：

- `document.yaml`：版本、发布机构、效力、原件和哈希；
- `data/tree.json`：PageIndex层级树；
- `data/index.md`：人类可读目录；
- `data/knowledge.jsonl`：Agent检索知识卡；
- `data/nodes.jsonl`：章、条、款、项及完整原文；
- `extraction/pages.jsonl`：物理页或非PDF来源单元；
- `review/validation.json`：验收与警告；
- `source/original.*`：原件。

## 2. 分类与优先级

| 分类代码 | 内容 | 使用边界 |
| --- | --- | --- |
| `LEGAL_GOVERNANCE` | 法律法规与制度 | 确定职责、许可、禁止和监管边界 |
| `STANDARD_SPEC` | 标准规范 | 形成技术要求、章节结构和检查项 |
| `PLAN_PROCEDURE` | 预案与作业规程 | 形成响应、协同和处置流程 |
| `CASE_PRACTICE` | 案例与实践经验 | 提供已采用措施和场景启发 |
| `METHOD_RESEARCH` | 方法指南与研究 | 补充通用方法，不替代国内依据 |
| `PROJECT_DATA` | 项目资料与数据定义 | 约束智能体任务、数据和指标口径 |

同一问题优先使用现行且适用的上位依据。案例和方法指南不能覆盖法规或标准。

## 3. 脚本接口

所有子命令支持：

```text
--knowledge-root PATH
--json
```

### `stats`

检查知识库是否可用，返回验收文档、节点、知识和分类统计。

### `documents`

```text
documents [--class CODE] [--doc-id ID] [--tag TAG] [--all-status]
```

默认只返回`validation_status == accepted`文档。

### `search`

```text
search QUERY
  [--class CODE] [--doc-id ID]
  [--tag TAG] [--stage STAGE] [--scenario SCENARIO] [--actor ACTOR]
  [--knowledge-type TYPE] [--force FORCE]
  [--limit N] [--all-status]
```

多次提供同一筛选参数表示任一值命中。不同种类筛选之间为“且”关系。

### `tree`

```text
tree DOC_ID [--depth N] [--contains TEXT]
```

`--contains`只显示标题、摘要或标签命中的分支及其祖先。

### `node`

```text
node NODE_ID
```

返回完整节点原文、层级路径、页码和引用该节点的知识卡。

### `cite`

```text
cite KNOWLEDGE_ID
```

返回知识正文、规范强度、节点信息、原件路径和可复制引用。

## 4. 查询设计

不要只提交宽泛问题。将查询拆成：

- 对象：轨道、公交、网约车、停车、人群；
- 阶段：筹备、到场、入场、活动期间、散场、恢复；
- 场景：大客流、拥挤、恶劣天气、事故、设备故障；
- 主体：承办方、公安、交通主管部门、运营单位；
- 动作：监测、预警、管控、疏散、接驳、信息发布；
- 输出：依据、措施、流程、阈值、职责或检查清单。

示例：

```bash
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  search \
  "演唱会 散场 轨道 客流 疏导 接驳 信息发布" \
  --stage 散场 --limit 12
```

若一次查询同时包含多个独立问题，应分别检索后合并，避免高频通用词压低精确条款。

## 5. 结果字段

关键字段：

- `knowledge_id`：稳定知识标识；
- `statement`：可检索知识正文；
- `knowledge_type`：要求、禁止、职责、措施、事实等；
- `normative_force`：强制、禁止、推荐、允许、信息或经验；
- `source_refs`：节点和页码/来源单元；
- `verification_status`：自动或人工复核状态；
- `score`：词法相关度，仅用于排序，不代表权威性。

权威性由文档类别、效力、状态、适用范围和发布机构决定，不由搜索分数决定。

## 6. 引用与复核

PDF 引用必须使用物理页码，正文印刷页码仅作补充。脚本返回的本地文件路径可用于打开原件：

```text
.../source/original.pdf#page=N
```

若网页内嵌官方 PDF，引用其`source/official-attachment.pdf`。

非 PDF 使用`source_unit`和`line_start`、`line_end`定位，并回读`source/original.html`或Markdown原件。

发现下列情况时停止直接引用：

- 文档未通过`accepted`；
- 文档状态未知、已废止或被替代；
- 条款没有有效来源定位；
- OCR文字与页面视觉不一致；
- 查询结果省略了关键条件或主体；
- 多份文档存在版本或职责冲突。
