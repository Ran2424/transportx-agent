# 数据治理与重建

## 来源与标准层

- 原始治理库按数据集登记来源路径、文件类型、粒度、行数、字段和抽取SQL。
- `std_*` 保留接纳记录、`source_row_id`、源ID、重复序号和质量状态。
- `fact_*` 只暴露通过默认规则、未删除且取规范重复记录的事实。
- 生成资产保留源字段和标准字段；标准化不会覆盖或伪造源值。

## 统一ID

- 既有20条轨交统一 `line_id` 和既有物理 `station_id` 保持稳定。
- 高德方向/支线路径使用独立 `route_direction_id`，再映射到统一线路。
- 高德站点优先按稳定源ID映射；仅在源ID不能匹配时使用唯一精确站名。
- 同名不同物理站不得只凭名称合并。
- 公交官方站点与高德站点缺少可靠一一映射，使用 `OFFICIAL:`、`AMAP:` 前缀避免碰撞。
- 默认事实暴露统一业务ID；源ID只用于 `std_*`、`map_*` 和目录审计。

## 质量规则

错误级规则要求全部通过，至少包括：

- 源数据集覆盖完整。
- 公交客流线路、轨交客流站点和高德轨交站点ID映射完整。
- 公交/轨交标准空间对象为 EPSG:4326。
- 公交方向站序、轨交方向站序和统一轨交线站关系的点线距离不超过25米。
- 默认事实不暴露源业务实体ID。
- 原始订单号不进入分发资产。

查询最近构建结果：

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/query_assets.py" --sql "SELECT r.severity,q.* FROM catalog.meta_quality_result q JOIN catalog.meta_quality_rule r USING(rule_code) ORDER BY r.severity,q.rule_code"
```

已知警告及精确数量统一维护在 `coverage.md`，不要把警告写成错误级失败。

## 隐私

- 原始订单号不进入分发数据库，只保存不可逆 SHA-256 `order_hash`。
- 订单级精确时间和坐标属于敏感数据；对外输出优先使用15分钟聚合。
- 包含原始订单号的治理库、原始文件和生成的 SQLite 数据库不提交到 Git。

## 分发边界

- 本地安装包可包含 `assets/databases/*.sqlite`，供 `query_assets.py` 只读查询。
- Git 仓库忽略 `*.sqlite` 和 `*.db`，只版本化技能说明、参考文档和构建/查询脚本。
- 缺少数据库的 Git checkout 不能直接回答数据查询；需要受控安装包或重建输入。

## 重建流程

构建脚本会删除并重建目标 SQLite 文件。只有在用户明确要求、源路径已核实并允许覆盖生成资产时执行。

从原始文件构建治理库：

```bash
SHANGHAI_TRAFFIC_PROJECT_ROOT=/absolute/source/project \
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/build_data_governance.py"
```

从治理库构建分域资产：

```bash
SHANGHAI_TRAFFIC_SOURCE_DB=/absolute/source/project/data/traffic_governance.sqlite \
SHANGHAI_TRAFFIC_SKILL_DIR=/absolute/skill/path \
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/build_agent_data_assets.py"
```

重建后必须重新运行：

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/query_assets.py" --list
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/query_assets.py" --sql "SELECT * FROM catalog.meta_quality_result"
```
