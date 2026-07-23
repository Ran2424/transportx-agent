# catalog.sqlite 表与字段

## 导航

- [定位与表清单](#定位)
- [字段](#字段)
- [常用 SQL](#常用-sql)

## 定位

`catalog.sqlite` 是查询入口和治理目录，不存放交通事实。Agent 在不知道使用哪张业务表时，先查这里。

常用命令：

```bash
"$PYTHON" "$QUERY" --coverage
"$PYTHON" "$QUERY" --metrics
"$PYTHON" "$QUERY" --ids
"$PYTHON" "$QUERY" --examples
```

## 表清单

| 表 | 行数 | 粒度 | 用途 |
|---|---:|---|---|
| `meta_build` | 9 | 一个构建属性 | 版本、构建时间、时区、CRS、源库哈希 |
| `meta_database` | 5 | 一个业务数据库 | 文件、领域、用途和大小 |
| `meta_table` | 48 | 一个业务表或视图 | 对象类型、层次、行数和说明 |
| `meta_column` | 543 | 一个业务字段 | 技术字段字典 |
| `meta_source_dataset` | 32 | 一个源数据集 | 来源、粒度、行数和目标 |
| `meta_source_extract_sql` | 1 | 一份抽取 SQL | 道路源抽取逻辑 |
| `meta_relationship` | 16 | 一条对象关系 | 连接键、基数和说明 |
| `meta_entity_id` | 12 | 一类统一实体 | 规范对象和 ID 策略 |
| `meta_id_mapping` | 2,500 | 一个源 ID 映射 | 源 ID 到统一 ID |
| `meta_metric` | 9 | 一个指标 | 粒度、单位和 SQL 口径 |
| `meta_analysis_guide` | 6 | 一个业务领域 | 推荐对象、覆盖和限制 |
| `meta_order_source_relation` | 4 | 一个订单来源关系指标 | 网约车与场馆订单重叠 |
| `meta_quality_rule` | 20 | 一条质量规则 | 领域、严重度和规则 |
| `meta_quality_result` | 20 | 一条本次质量结果 | 是否通过、观测值和说明 |
| `meta_query_example` | 6 | 一个查询样例 | 问题、SQL 和治理提示 |

## 字段

### `meta_build`

`key TEXT`，`value TEXT`

重要键：`asset_version`、`built_at`、`canonical_crs`、`canonical_time_zone`、`source_database_sha256`、`privacy_policy`。

### `meta_database`

`database_name TEXT`，`file_name TEXT`，`domain_name_cn TEXT`，`purpose TEXT`，`size_bytes INTEGER`

### `meta_table`

`database_name TEXT`，`table_name TEXT`，`object_type TEXT`，`governance_layer TEXT`，`row_count INTEGER`，`description_cn TEXT`

`governance_layer` 取表名前缀，如 `dim`、`fact`、`mart`、`std`。

### `meta_column`

`database_name TEXT`，`table_name TEXT`，`ordinal_position INTEGER`，`column_name TEXT`，`declared_type TEXT`，`is_not_null INTEGER`，`is_primary_key INTEGER`

这里是技术字典；中文业务定义需结合本文件和相应分库 Reference。

### `meta_source_dataset`

`source_table TEXT`，`source_path TEXT`，`source_domain TEXT`，`source_grain TEXT`，`source_row_count INTEGER`，`target_database TEXT`，`target_table TEXT`，`transform_note TEXT`

### `meta_source_extract_sql`

`source_name TEXT`，`source_sql TEXT`

### `meta_relationship`

`relationship_id TEXT`，`from_object TEXT`，`from_column TEXT`，`to_object TEXT`，`to_column TEXT`，`cardinality TEXT`，`join_note TEXT`

### `meta_entity_id`

`entity_code TEXT`，`domain_code TEXT`，`entity_name_cn TEXT`，`canonical_object TEXT`，`canonical_id_column TEXT`，`id_scope TEXT`，`source_id_policy TEXT`

### `meta_id_mapping`

`mapping_id INTEGER`，`entity_code TEXT`，`source_system TEXT`，`source_id TEXT`，`source_context TEXT`，`canonical_id TEXT`，`mapping_method TEXT`，`confidence REAL`

同名实体不能仅凭名称合并。查询映射时同时检查 `mapping_method` 和 `confidence`。

### `meta_metric`

`metric_code TEXT`，`metric_name_cn TEXT`，`domain_code TEXT`，`grain TEXT`，`unit TEXT`，`definition TEXT`，`source_object TEXT`，`sql_expression TEXT`

### `meta_analysis_guide`

`domain_code TEXT`，`recommended_object TEXT`，`grain TEXT`，`min_date_key INTEGER`，`max_date_key INTEGER`，`entity_coverage TEXT`，`spatial_scope TEXT`，`crs_policy TEXT`，`usage_note TEXT`

### `meta_order_source_relation`

`relation_code TEXT`，`order_count INTEGER`，`denominator_count INTEGER`，`ratio REAL`，`interpretation_cn TEXT`

重点行：

- `RIDEHAIL_ORDER_UNION`：上车和下车订单并集；
- `VENUE_ORDER_UNION`：场馆到场和离场订单并集；
- `VENUE_IN_RIDEHAIL_OVERLAP`：两个订单集合的交集；
- `VENUE_ONLY_ORDERS`：只在场馆来源出现的订单。

### `meta_quality_rule`

`rule_code TEXT`，`domain_code TEXT`，`severity TEXT`，`rule_description TEXT`

### `meta_quality_result`

`rule_code TEXT`，`checked_at TEXT`，`passed INTEGER`，`observed_value TEXT`，`result_note TEXT`

`ERROR` 规则失败表示资产不应发布；`WARN` 表示记录保留但查询必须说明限制。

### `meta_query_example`

`example_id TEXT`，`question_cn TEXT`，`sql_text TEXT`，`governance_note TEXT`

## 常用 SQL

```sql
-- 找某领域推荐对象
SELECT *
FROM catalog.meta_analysis_guide
WHERE domain_code = 'RIDEHAIL';

-- 查看错误级质量结果
SELECT r.severity, q.*
FROM catalog.meta_quality_result q
JOIN catalog.meta_quality_rule r USING (rule_code)
WHERE r.severity = 'ERROR';

-- 查看一个对象的字段
SELECT ordinal_position, column_name, declared_type, is_not_null
FROM catalog.meta_column
WHERE database_name = 'ridehail' AND table_name = 'fact_trip'
ORDER BY ordinal_position;
```
