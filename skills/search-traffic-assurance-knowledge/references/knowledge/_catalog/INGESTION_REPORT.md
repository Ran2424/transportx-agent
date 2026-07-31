# Knowledge 入库报告

- 生成时间：2026-07-26T09:33:11+08:00
- 逻辑文档：38
- 原文节点：3828
- 知识卡片：3363
- 已验收：38
- 降级解析文档：24
- 无文本物理页/来源单元：18

## 验收结论

所有文档均通过哈希、元数据、页序、层级父子关系、节点来源、知识来源、标签及知识长度自动检查，并完成逐文档抽查。PDF 共渲染 89 个抽样页进行视觉复核。

当前 MinerU token 返回 401，因此本批 PDF 使用已有结构化文本或 PyPDF/书签降级解析。具体解析器和警告记录在各文档 `extraction/extraction.json`；原 PDF、SHA-256 和页级定位均已保留。令牌恢复后可按源哈希重建。

> `accepted` 表示文档级入库验收通过。涉及封路、停运、限流、警力部署、响应级别、法定职责或对外发布的知识，在正式方案中使用前仍须将对应知识条目标记为 `manual_verified`。

## 文档明细

| doc_id | 分类 | 解析器 | 来源单元 | 节点 | 知识 | 抽查 | 状态 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `PROJECT-AGENT-CHALLENGE-20260622` | 项目资料与数据定义 | `pypdf_fallback` | 3 | 4 | 3 | 2/2 | `accepted` |
| `PROJECT-METRIC-DEFINITIONS` | 项目资料与数据定义 | `source_conversion` | 2 | 3 | 2 | 2/2 | `accepted` |
| `PROJECT-DATA-GOVERNANCE` | 项目资料与数据定义 | `source_conversion` | 7 | 8 | 6 | 3/3 | `accepted` |
| `PROJECT-DATA-ASSET-MODEL` | 项目资料与数据定义 | `source_conversion` | 8 | 9 | 7 | 3/3 | `accepted` |
| `PROJECT-TRAFFIC-DATA-INVENTORY` | 项目资料与数据定义 | `source_conversion` | 11 | 12 | 11 | 2/2 | `accepted` |
| `CN-EMERGENCY-RESPONSE-LAW-2024` | 法律法规与制度 | `pypdf_fallback` | 33 | 148 | 127 | 3/3 | `accepted` |
| `CN-ROAD-TRAFFIC-SAFETY-LAW-2021` | 法律法规与制度 | `source_conversion` | 11 | 144 | 129 | 4/4 | `accepted` |
| `CN-URBAN-PUBLIC-TRANSPORT-REG-793` | 法律法规与制度 | `pypdf_fallback` | 16 | 78 | 70 | 3/3 | `accepted` |
| `CN-LARGE-MASS-EVENT-SAFETY-REG-505` | 法律法规与制度 | `pypdf_fallback` | 9 | 41 | 32 | 3/3 | `accepted` |
| `CN-EMERGENCY-PLAN-MANAGEMENT-2024` | 法律法规与制度 | `source_conversion` | 2 | 53 | 44 | 3/3 | `accepted` |
| `SH-CROWD-GATHERING-SAFETY-MEASURES-29` | 法律法规与制度 | `pypdf_fallback` | 16 | 64 | 60 | 3/3 | `accepted` |
| `SH-EMERGENCY-PLAN-MANAGEMENT-2025` | 法律法规与制度 | `pypdf_fallback` | 16 | 72 | 60 | 4/4 | `accepted` |
| `SH-PUBLIC-CROWD-ACTIVITY-SAFETY-2019` | 法律法规与制度 | `source_conversion` | 2 | 22 | 20 | 4/4 | `accepted` |
| `SH-PUBLIC-CROWD-ACTIVITY-SAFETY-EXTENSION-2025` | 法律法规与制度 | `embedded_pdf_pypdf_fallback` | 2 | 3 | 2 | 2/2 | `accepted` |
| `SH-RIDE-HAILING-RULES-2024` | 法律法规与制度 | `pypdf_fallback` | 11 | 36 | 32 | 3/3 | `accepted` |
| `SH-RAIL-TRANSIT-SAFETY-MEASURES-2022` | 法律法规与制度 | `pypdf_fallback` | 20 | 59 | 51 | 4/4 | `accepted` |
| `SH-RAIL-TRANSIT-SERVICE-RULES-2025` | 法律法规与制度 | `pypdf_fallback` | 18 | 61 | 46 | 3/3 | `accepted` |
| `CN-URBAN-RAIL-PASSENGER-ORG-2025` | 法律法规与制度 | `pypdf_fallback` | 16 | 69 | 61 | 3/3 | `accepted` |
| `CN-URBAN-RAIL-DRILL-MANAGEMENT-2024` | 法律法规与制度 | `pypdf_fallback` | 11 | 34 | 33 | 3/3 | `accepted` |
| `CN-URBAN-RAIL-OPERATIONS-REG-2018` | 法律法规与制度 | `source_conversion` | 4 | 68 | 59 | 4/4 | `accepted` |
| `CN-NATIONAL-EMERGENCY-PLAN-2025` | 预案与作业规程 | `source_conversion` | 3 | 42 | 33 | 3/3 | `accepted` |
| `SH-LARGE-PASSENGER-FLOW-PLAN-2022` | 预案与作业规程 | `pypdf_fallback` | 172 | 512 | 399 | 5/5 | `accepted` |
| `GBT33170.1-2016` | 标准规范 | `legacy_structured_fallback` | 13 | 53 | 38 | 4/4 | `accepted` |
| `GBT33170.2-2016` | 标准规范 | `legacy_structured_fallback` | 11 | 77 | 60 | 4/4 | `accepted` |
| `GBT33170.3-2016` | 标准规范 | `legacy_structured_fallback` | 10 | 71 | 59 | 3/3 | `accepted` |
| `GBT33170.4-2016` | 标准规范 | `legacy_structured_fallback` | 10 | 87 | 67 | 3/3 | `accepted` |
| `GBT33170.5-2016` | 标准规范 | `legacy_structured_fallback` | 13 | 64 | 49 | 4/4 | `accepted` |
| `GBT37228-2025` | 标准规范 | `legacy_structured_fallback` | 22 | 110 | 81 | 4/4 | `accepted` |
| `GBT46791-2025` | 标准规范 | `legacy_structured_fallback` | 19 | 81 | 50 | 4/4 | `accepted` |
| `GBT46793.1-2025` | 标准规范 | `legacy_structured_fallback` | 15 | 47 | 32 | 3/3 | `accepted` |
| `GBT46793.2-2025` | 标准规范 | `legacy_structured_fallback` | 23 | 144 | 99 | 4/4 | `accepted` |
| `GBT46793.3-2025` | 标准规范 | `legacy_structured_fallback` | 19 | 70 | 50 | 4/4 | `accepted` |
| `SH-CASE-CIIE-2024` | 案例与实践经验 | `source_conversion` | 1 | 9 | 7 | 2/2 | `accepted` |
| `SH-CASE-STADIUM-CONCERT-PR-2025` | 案例与实践经验 | `source_conversion` | 1 | 24 | 18 | 2/2 | `accepted` |
| `SH-CASE-TOURISM-FESTIVAL-PARADE-2025` | 案例与实践经验 | `source_conversion` | 1 | 9 | 8 | 2/2 | `accepted` |
| `SH-CASE-TFBOYS-STADIUM-2025` | 案例与实践经验 | `source_conversion` | 1 | 27 | 25 | 2/2 | `accepted` |
| `SH-CASE-F1-2026` | 案例与实践经验 | `source_conversion` | 1 | 15 | 14 | 2/2 | `accepted` |
| `FHWA-PSE-HANDBOOK-2004` | 方法指南与研究 | `pypdf_outline_fallback` | 448 | 1398 | 1419 | 5/5 | `accepted` |

## 复现命令

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 scripts/ingest_knowledge.py build
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 scripts/render_review_samples.py
```
