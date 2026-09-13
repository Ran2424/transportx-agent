# 数据治理与重建

## 默认规则

- 原始记录不覆盖，标准层保留来源文件和源行。
- 五一铁路样例不进入默认生产事实。
- 出租车 `RT_VW` 只登记为重复来源。
- 预测的不同发布时间全部保留。
- 空值、缺测和真实零分开。
- 代码关联前去除外围空格，原值仍保存在治理库。
- 未确认指标和状态码不推测含义。

## 重建

构建会替换指定输出文件。先核实源目录和输出目录：

```bash
PYTHON="/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10"
SKILL_ROOT="<本 Skill 根目录>"
SOURCE_ROOT="<三个已解压数据包所在目录>"
MODULE_ROOT="<Module 根目录>"

"$PYTHON" "$SKILL_ROOT/scripts/build_governance_db.py" \
  --source-root "$SOURCE_ROOT" \
  --output "$MODULE_ROOT/.build/hub_traffic_governance.sqlite"

"$PYTHON" "$SKILL_ROOT/scripts/build_agent_data_assets.py" \
  --governance-db "$MODULE_ROOT/.build/hub_traffic_governance.sqlite" \
  --output-dir "$MODULE_ROOT/assets/databases"

"$PYTHON" "$SKILL_ROOT/scripts/validate_assets.py" \
  --data-root "$MODULE_ROOT/assets/databases"
```

构建完成后运行 `query_assets.py --coverage`、`--quality`、`--conflicts` 和验证问题。数据库与源数据不进入 Git。
