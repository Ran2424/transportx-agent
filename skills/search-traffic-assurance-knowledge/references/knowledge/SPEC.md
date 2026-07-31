# 重大活动交通保障知识库入库规范

版本：1.1.0  
状态：强制执行  
生效日期：2026-07-26  
适用目录：`knowledge/`

## 1. 目的与约束

本规范定义文档分类、PDF解析、层级拆分、知识提炼、标签、引用和验收要求。

- **必须**：不满足即入库失败；
- **应**：原则上执行，例外必须记录原因；
- **可**：允许采用的增强能力；
- **不得**：明确禁止。

后续新增、迁移或重新处理的文档必须遵循本规范。未通过验收的文档不得进入 Agent 默认检索范围。

## 2. 核心原则

1. **原件优先**：原始 PDF、HTML、DOCX 是内容依据，其余均为可重建的派生数据。
2. **原文与知识分离**：原文结构写入 `nodes.jsonl`，提炼知识写入 `knowledge.jsonl`。
3. **结构导航优先**：Agent 先查目录树，再定位节点，最后回读原文和 PDF。
4. **一级分类互斥**：每份文档只能属于一个一级分类，交叉属性使用标签表达。
5. **引用可验证**：每条知识必须关联来源节点；PDF 节点必须记录物理页码。
6. **构建可重复**：不得直接修改自动生成文件，人工修订通过补丁记录。

## 3. 一级分类

| 分类代码 | 目录 | 判定标准 |
| --- | --- | --- |
| `LEGAL_GOVERNANCE` | `01_法律法规与制度` | 规定权利义务、职责、审批、监管或制度约束 |
| `STANDARD_SPEC` | `02_标准规范` | 具有正式标准编号或明确技术标准属性 |
| `PLAN_PROCEDURE` | `03_预案与作业规程` | 规定响应、保障、处置或操作流程 |
| `CASE_PRACTICE` | `04_案例与实践经验` | 记录实际活动、措施、结果或复盘 |
| `METHOD_RESEARCH` | `05_方法指南与研究` | 提供通用方法、研究或非约束性指南 |
| `PROJECT_DATA` | `06_项目资料与数据定义` | 本项目需求、指标、数据模型和治理规则 |

按以下顺序判定，命中后停止：

1. 有 GB、GB/T、JT/T、DB 等正式标准编号 → `STANDARD_SPEC`；
2. 正文主体是预案、保障方案或作业程序 → `PLAN_PROCEDURE`；
3. 具有法律、法规、规章、规范性文件或制度属性 → `LEGAL_GOVERNANCE`；
4. 描述真实活动实施或复盘 → `CASE_PRACTICE`；
5. 提供通用方法或研究 → `METHOD_RESEARCH`；
6. 仅服务本项目内部 → `PROJECT_DATA`。

示例：

- `GB/T 46793.1-2025`虽涉及预案，仍归 `STANDARD_SPEC`；
- `国家突发事件总体应急预案`归 `PLAN_PROCEDURE`；
- `突发事件应急预案管理办法`归 `LEGAL_GOVERNANCE`；
- 名称含“规范”但以行政规范性文件发布的文件归 `LEGAL_GOVERNANCE`。

## 4. 标识与目录

### 4.1 标识

- `doc_id`必须全库唯一、稳定，只使用字母、数字、点、下划线和连字符；
- 标准优先使用规范化编号，如 `GBT33170.2-2016`；
- 不同版本必须使用不同 `doc_id`；
- 同一系列通过 `series_id`关联；
- 节点 ID：`<doc_id>@<locator>`；
- 知识 ID：`K-<doc_id>-<六位序号>`；
- 无正式编号的节点使用稳定顺序号，如 `sec-0001`。

### 4.2 单文档目录

```text
<一级分类目录>/<doc_id>/
├── document.yaml
├── source/
│   ├── original.pdf
│   ├── official-metadata.html       # 可选
│   └── SHA256SUMS.txt
├── extraction/
│   ├── mineru.md
│   ├── mineru-assets/
│   ├── pages.jsonl
│   └── extraction.json
├── data/
│   ├── nodes.jsonl
│   ├── knowledge.jsonl
│   ├── tree.json
│   └── index.md
└── review/
    ├── patches.jsonl
    └── validation.json
```

知识库根目录维护：

```text
knowledge/_catalog/
├── documents.jsonl
├── taxonomy.yaml
├── aliases.yaml
├── relations.jsonl
└── build.json
```

规则：

- `source/original.<ext>`不可修改；PDF 使用 `original.pdf`，其他格式保留原扩展名；
- MinerU 返回的图片、表格、布局 JSON 等资源必须完整保留；
- `tree.json`、`index.md`和全局目录必须自动生成；
- 文档目录不得混入其他文档资料。

## 5. 核心数据

所有 JSONL 记录必须包含 `schema_version`。当前版本为 `1.0.0`。

### 5.1 文档元数据

`document.yaml`至少包含：

```yaml
schema_version: "1.0.0"
doc_id: "GBT33170.2-2016"
series_id: "GBT33170.2"
document_class: "STANDARD_SPEC"
document_subtype: "national_recommended_standard"
title: "大型活动安全要求 第2部分：人员管控"
official_number: "GB/T 33170.2-2016"
language: "zh-CN"
jurisdiction: "CN"
issuer: "国家标准发布机构"
publication_date: "2016-10-13"
effective_date: "2017-04-01"
expiry_date: null
status: "effective"
binding_force: "recommended"
source_url: null
retrieved_at: null
source_file: "source/original.pdf"
source_sha256: "<sha256>"
pdf_page_count: 11
supersedes: []
superseded_by: []
```

`status`取值：

```text
effective | not_yet_effective | amended | superseded |
repealed | expired | unknown
```

`binding_force`取值：

```text
mandatory | recommended | guidance | internal | experience | unknown
```

正式用于方案或预案生成前，`status`不得为 `unknown`。

### 5.2 页级记录

`extraction/pages.jsonl`每行对应一个物理 PDF 页；非 PDF 文档每行对应一个可定位的来源单元，`pdf_page`为 `null`，并补充 `line_start`、`line_end`或 HTML 锚点：

```json
{
  "schema_version": "1.0.0",
  "page_id": "GBT33170.2-2016@pdf-0007",
  "doc_id": "GBT33170.2-2016",
  "pdf_page": 7,
  "printed_page": "4",
  "printed_page_confidence": 1.0,
  "width": 595.0,
  "height": 842.0,
  "raw_text": "<原始提取文本>",
  "normalized_text": "<去除重复页眉页脚后的文本>",
  "text_source": "mineru",
  "ocr_confidence": null,
  "has_table": false,
  "has_figure": false,
  "verification_status": "page_aligned"
}
```

要求：

- PDF 的 `pdf_page`从 1 开始，与 PDF 阅读器页序一致；
- `printed_page`记录页面上实际印刷页码，无法确认时为 `null`；
- PDF 页级记录数必须等于 PDF 物理页数；非 PDF 来源单元必须覆盖全部入库正文；
- 物理页码和正文印刷页码不得混用。

### 5.3 原文节点

`data/nodes.jsonl`每行对应章、条、款、项、表格、图片或附录节点：

```json
{
  "schema_version": "1.0.0",
  "node_id": "GBT33170.2-2016@6.3.2",
  "doc_id": "GBT33170.2-2016",
  "parent_id": "GBT33170.2-2016@6.3",
  "node_type": "clause",
  "number": "6.3.2",
  "locator": "6.3.2",
  "title": null,
  "order": 6320,
  "depth": 3,
  "heading_path": ["6 监测", "6.3 活动范围监测", "6.3.2"],
  "source_text": "人员和车辆在允许进入区域内的需要监测的行为包括……",
  "normalized_text": "人员和车辆在允许进入区域内需要监测的行为包括……",
  "page_refs": [
    {
      "pdf_page": 7,
      "printed_page": "4",
      "bbox": null,
      "quote": "人员和车辆在允许进入区域内的需要监测的行为包括……"
    }
  ],
  "tags": [],
  "verification_status": "page_aligned",
  "source_sha256": "<sha256>"
}
```

`node_type`取值：

```text
document | part | chapter | section | article | clause | paragraph |
item | subitem | table | figure | appendix | note | reference
```

要求：

- `source_text`保留提取原文；
- `normalized_text`只修复断行、空格、乱码和经确认的 OCR 错误；
- 不得改变“应、宜、可、不得”等规范强度；
- 跨页节点必须记录多个 `page_refs`；
- `parent_id`必须存在，节点树不得有环或孤立节点；
- 表格、图片和注释不得混入相邻条款正文；
- `source_sha256`必须与 `document.yaml`一致。

坐标可用时，`bbox`使用左上角为原点、0 至 1 的归一化坐标 `[x0,y0,x1,y1]`；无法确认时为 `null`。

### 5.4 知识卡片

`data/knowledge.jsonl`每行是一条供 Agent 检索的知识：

```json
{
  "schema_version": "1.0.0",
  "knowledge_id": "K-GBT33170.2-2016-000042",
  "doc_id": "GBT33170.2-2016",
  "statement": "大型活动应对允许进入区域内人员和车辆的异常行为进行监测。",
  "knowledge_type": "requirement",
  "normative_force": "recommended",
  "source_modality": "应",
  "conditions": [],
  "actors": ["活动承办者"],
  "objects": ["人员", "车辆"],
  "actions": ["监测异常行为"],
  "applicable_stages": ["活动期间"],
  "topics": ["人员管控", "区域权限", "异常行为监测"],
  "scenarios": [],
  "source_refs": [
    {
      "node_id": "GBT33170.2-2016@6.3.2",
      "pdf_page": 7,
      "printed_page": "4"
    }
  ],
  "derivation": "abstractive",
  "confidence": 0.9,
  "verification_status": "pending_review"
}
```

`knowledge_type`取值：

```text
definition | requirement | prohibition | permission | recommendation |
responsibility | condition | threshold | procedure | risk | measure |
fact | lesson
```

`normative_force`取值：

```text
mandatory | prohibited | recommended | permitted |
informational | experience
```

要求：

- 一条知识可引用多个节点，一个节点可产生多条知识；
- `statement`必须保留主体、条件、动作和规范强度；
- 推荐性标准不得被表述成法律强制义务；
- 案例措施必须标记为 `experience`；
- 不确定的规范强度标记为 `informational`并进入人工审核；
- `derivation`只能为 `extractive`或 `abstractive`；
- 每条知识必须至少有一个有效 `source_ref`。

## 6. MinerU 解析与页码对齐

PDF 内容解析应优先使用 MinerU。当前工作区使用：

```text
Python:
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10

MinerU runner:
/Users/ran/.codex/skills/mineru-pdf-to-markdown/scripts/process_pdf_with_mineru.py
```

MinerU runner 默认生成 `paper/<材料ID>.md`，该文件只是中间结果。入库时必须：

1. 将 Markdown 归档为 `extraction/mineru.md`；
2. 将全部非 Markdown 产物归档至 `extraction/mineru-assets/`；
3. 在 `extraction/extraction.json`记录模型版本、语言、时间、源文件哈希、无密钥的命令和警告；
4. 结合 MinerU 页级/布局结果、PDF 物理页序和页面渲染建立 `pages.jsonl`；
5. 不得仅依赖合并后的 `full.md`推断页码。

解析前必须检查 PDF 可读性、页数、SHA-256、重复文档、目标目录和 MinerU token。默认不得覆盖已有结果。

`extraction.json`至少包含：

```json
{
  "schema_version": "1.0.0",
  "extractor": "mineru",
  "model_version": "vlm",
  "language": "ch",
  "started_at": "2026-07-26T00:00:00+08:00",
  "completed_at": "2026-07-26T00:00:00+08:00",
  "source_sha256": "<sha256>",
  "command": "<sanitized command without token>",
  "mineru_output_preserved": true,
  "warnings": []
}
```

任何 token、密钥或认证信息不得写入知识库。

## 7. 层级树与 Agent 检索

典型层级：

```text
标准：document → chapter → clause → item → note/table/figure
法律：document → chapter → section → article → paragraph → item
预案：document → chapter → section → paragraph → item
案例：document → section → subsection → paragraph → table/figure
```

`data/tree.json`是 PageIndex 风格导航树，由 `nodes.jsonl`生成，只保留节点 ID、编号、标题、类型、页范围、派生摘要、标签和子节点。摘要不得替代原文。

Agent 必须按以下顺序检索：

1. 根据类别、阶段、交通方式和场景筛选 `_catalog/documents.jsonl`；
2. 排除无效、废止或不适用文档；
3. 阅读候选文档 `tree.json`或 `index.md`；
4. 定位节点并搜索 `knowledge.jsonl`；
5. 回读 `nodes.jsonl`核对原文、条件和规范强度；
6. 获取 PDF 页码并生成引用；
7. 生成结果并检查法规、标准、案例的使用边界。

不得仅依据目录摘要生成正式结论。

## 8. 标签与关系

正式标签必须来自 `_catalog/taxonomy.yaml`，至少包含：

- `domain`：交通组织、轨道、公交、出租与网约车、停车、人群管控等；
- `stage`：筹备、到场、入场、活动期间、散场、恢复；
- `scenario`：大客流、拥挤、恶劣天气、事故、设备故障等；
- `actor`：主办方、承办方、公安、交通主管部门、运营单位等；
- `location`：场馆、道路、车站、站点、停车场、集散通道等；
- `output_section`：组织架构、需求研判、交通组织、运力、预警、响应、信息发布、复盘等。

同义词存入 `aliases.yaml`，仅用于查询扩展。模型新生成的标签先写入 `candidate_tags`，审核后才能进入正式分类表。

`relations.jsonl`可记录引用、修订、替代、上位依据和配套关系。关系必须有来源，不得猜测。

## 9. 引用

PDF 引用格式：

```text
《文档名称》条款号，PDF第N页（正文第M页）。
```

无印刷页码时省略括号；案例没有条款号时使用章节标题。

引用必须能取得：

- `doc_id`、标题、版本或发布日期；
- 节点编号或章节；
- `pdf_page`及可确认的 `printed_page`；
- 原文短摘录；
- `source_sha256`。

本地链接使用物理 PDF 页码：

```markdown
[查看 PDF 原文](../source/original.pdf#page=7)
```

## 10. 纠错、版本与重建

不得直接修改 `pages.jsonl`、`nodes.jsonl`、`knowledge.jsonl`。

人工纠错写入 `review/patches.jsonl`，必须记录目标、字段、旧值、新值、原因、PDF证据页、审核人和时间。重新构建时先生成基础数据，再顺序应用补丁。

出现以下情况必须重新构建：

- PDF SHA-256 变化；
- MinerU 模型或关键参数发生重大变化；
- 数据结构版本变化；
- 发现系统性 OCR 或层级错误；
- 文档发布修订版或替代文件。

新版本建立新目录，旧版本不得删除；通过 `series_id`、`supersedes`和 `superseded_by`关联。Agent 默认不得引用已废止或被替代版本。

## 11. 入库流程

每份文档必须依次完成：

1. 登记一级分类、`doc_id`、版本和来源；
2. 固化原件、来源 URL、获取时间和 SHA-256；
3. 使用 MinerU 解析并完整保留产物；
4. 生成 `pages.jsonl`并对齐两种页码；
5. 解析章、条、款、项，生成 `nodes.jsonl`；
6. 从节点生成 `tree.json`和 `index.md`；
7. 提炼 `knowledge.jsonl`并标注受控标签；
8. 建立知识 → 节点 → PDF 页的引用链；
9. 执行自动校验和人工抽查；
10. 验收通过后更新 `_catalog`并允许 Agent 检索。

步骤不得跳过；不适用时必须在 `validation.json`记录原因。

## 12. 校验与验收

自动校验必须确认：

- 元数据完整，`doc_id`全库唯一；
- PDF 哈希、页数和所有派生文件一致；
- `pages.jsonl`页码连续且数量正确；
- 节点无环、无孤立节点，同级顺序唯一；
- 所有 `page_refs`位于有效页范围；
- 所有知识均有有效来源节点；
- 所有正式标签存在于分类表；
- `tree.json`和全局目录可重新生成。

每份文档至少人工抽查：

- 首页和元数据；
- 正文第一条和最后一条；
- 一个跨页条款；
- 一个含“应、宜、可、不得”的条款；
- 一个表格或图片节点，如存在；
- 所有进入方案模板的关键知识。

`verification_status`取值：

```text
extracted | structured | page_aligned | auto_verified |
manual_verified | needs_review | rejected
```

涉及封路、停运、限流、警力部署、响应级别、法定职责和对外发布的知识，在用于正式输出前必须为 `manual_verified`。

`review/validation.json`必须记录文档 ID、源文件哈希、校验时间、自动检查结果、人工抽查结果、问题和最终状态。只有所有强制检查通过时，最终状态才能为 `accepted`。

## 13. 当前资料迁移

当前平铺文件属于历史布局。迁移时：

- 不删除或覆盖原始文件；
- 现有 `_检索文本.md`可用于页码对齐；
- 现有 `_结构化.md`可用于初始节点，但必须重新关联 PDF 页；
- 每份文档必须重新记录 PDF SHA-256并完成验收；
- 首轮选择一份标准、一份法律制度、一份预案和一份案例验证流程；
- 四类均通过后再批量迁移。
