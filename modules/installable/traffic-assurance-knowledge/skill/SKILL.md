---
name: search-traffic-assurance-knowledge
description: Search and cite the local major-event traffic-assurance knowledge base containing Chinese laws, standards, emergency plans, operational procedures, Shanghai event cases, project data definitions, and the FHWA handbook. Use when answering traffic保障 questions, finding legal or technical bases, drafting or reviewing保障方案/应急预案, building checklists, comparing event practices, or returning verifiable clause, source-unit, and PDF-page citations without a vector database.
---

# 重大活动交通保障知识检索

使用本 Skill 从结构化知识库检索依据。坚持“目录筛选 → 层级导航 → 知识命中 → 原文复核 → 引用”的 PageIndex 路径，不把目录摘要当作正式依据。

## 运行环境

- Python：使用 TransportX 会话上下文给出的内置解释器。
- 检索脚本：会话上下文“已装载 Module 资源”会列出本 Skill 根目录；使用该目录下的 `scripts/search_knowledge.py`。
- 知识库由独立 Knowledge 资产提供，运行时通过 `TRANSPORTX_KNOWLEDGE_ASSETS_JSON` 注入全部 Knowledge 资产；本 Skill 只读取其中 `knowledge:traffic-assurance` 的目录。Skill 不包含知识正文，也不从相邻目录回退。
- 替代知识库：仅在需要检索另一套同结构知识资产时使用 `--knowledge-root /absolute/path` 覆盖；该参数也可在没有环境变量时独立使用。

先运行：

```bash
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  stats
```

若目录不存在或没有`accepted`文档，停止并报告知识库位置或验收状态问题。

Knowledge 模块可包含原件、页级记录、层级树、知识卡、验收记录和全局目录。先按本文件流程通过检索脚本定位，不要递归读取整个知识目录；需要了解目录、入库规范或解析限制时，再分别读取已安装 Knowledge 根目录中的 `README.md`、`SPEC.md` 或 `_catalog/INGESTION_REPORT.md`。

## 检索流程

1. 从问题提取交通方式、活动阶段、风险情景、责任主体、地点和目标输出。
2. 用`documents`筛选候选文档；法规依据优先于标准、预案、案例和国外指南。
3. 对复杂任务先用`tree <doc_id>`查看候选文档层级，再用`search`检索知识卡。
4. 用`node <node_id>`回读完整节点、父级路径和来源定位。
5. 正式引用前用`cite <knowledge_id>`生成出处，并打开对应原始 PDF 页或 HTML 来源单元核对。
6. 汇总时区分法律强制、标准推荐、预案程序、案例经验和国外方法，不得混写效力。

## 常用命令

```bash
# 全库检索；默认仅搜索 accepted 文档
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  search "演唱会 散场 轨道交通 客流控制" --limit 8

# 仅在排查入库质量或结构化结果不足时纳入带页眉/页码残片的降级知识卡
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  search "客流控制" --include-page-fragments --limit 8

# 按类别、阶段、标签缩小范围
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  search "安全工作方案" \
  --class LEGAL_GOVERNANCE --stage 活动筹备 --tag 活动承办方

# 浏览候选文档和 PageIndex 树
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  documents --class STANDARD_SPEC
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  tree GBT33170.2-2016 --depth 4

# 回读原文节点、生成引用；机器编排时加 --json
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  node 'GBT33170.2-2016@8.4'
"<Python interpreter>" \
  "<skill-root>/scripts/search_knowledge.py" \
  cite 'K-GBT33170.2-2016-000058' --json
```

实际执行时使用会话上下文给出的内置 Python 路径，不依赖 shell 中的`python`命令。需要组合多个筛选项或机器读取输出时，阅读[检索与引用参考](references/retrieval-reference.md)。

## Web 引用

需要在回答中正式引用知识条目时，严格遵循 Citation v2：

1. 先用 `cite <knowledge_id> --json` 复核知识卡、`source_refs`、原件类型和页码；它只用于检索与核验，**不会**创建引用。
2. 调用 `tau_resolve_citation({ knowledgeIds: ["<knowledge_id>"] })`。Host 会以已选 Knowledge 资产中的原始 PDF/HTML 建立受控 Resource 与一个或多个精确 Locator；不得把 JSONL、Markdown 或绝对本地路径作为 artifact 传入。
3. 从返回的 Locator 中选择支持当前论断的页码、条款或来源单元，调用 `tau_cite({ locatorId: "<locatorId>", role: "support" })`。
4. 只使用 `tau_cite` 成功返回的 occurrence 标记，并紧跟在对应结论后：`[[cite:<occurrenceId>]]`。多个结论分别创建 occurrence；不要复用 `knowledge_id`、`locatorId` 或手写编号作为标记。
5. 不在回答中输出知识库绝对路径。Web 会将 occurrence 标记渲染为行内编号，并在消息末尾生成引用依据。
6. 生成独立 Markdown 报告时，正文只保留 `[[cite:<occurrenceId>]]` 标记，不得手写“参考依据”“参考文献”或引用表格。引用编译器会按正文首次使用顺序生成唯一的逐条出处列表。

## 输出规则

- 每项结论至少附`doc_id`、文档名称、条款/节点、物理 PDF 页或来源单元。
- PDF 引用格式：`《文档名》条款号，PDF第N页（正文第M页）`。
- 非 PDF 引用格式：`《文档名》条款或章节，来源单元及行号`。
- 推荐性国家标准中的“应”标为标准要求，不表述成法定义务。
- 案例知识统一视为经验，只能说明“曾采用”或“可参考”。
- FHWA 内容属于国外方法指南，必须说明适用性转换。
- 不确定、冲突或跨版本内容回到原件，不根据相似条款补写。
- `manual_review_required=true` 或 `quality_warnings` 非空时，必须回到原件复核；不得把页面占位节点或页眉残片直接写成正式结论。
- 报告产物保留正文中的 `[[cite:<occurrenceId>]]` 标记；参考依据由 Citation 编译器生成，模型不得自行生成或维护索引。

## 正式方案安全门

涉及封路、停运、限流、警力部署、响应级别、法定职责或对外发布时：

1. 必须打开原 PDF/官方 HTML 核对；
2. 必须确认版本、状态、适用范围和主体；
3. 知识卡未达到`manual_verified`时，明确标注“待业务/法务确认”；
4. 不得仅凭案例、目录摘要或国外指南直接形成执行指令。

生成完整保障方案或预案时，至少覆盖法规制度、技术标准、作业预案和同类案例四类来源；缺少某类时明确说明。
