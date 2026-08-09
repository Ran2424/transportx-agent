---
name: plot-style-playbook
description: |
  Apply reusable chart-design experience and visual styles to generate publication-quality matplotlib figures from user data.
  Use when: wants a chart;
  user asks to "plot this data", "make a bar chart", "draw a radar chart",  "把我的数据画出来";
---

# Plot Style Playbook

This is an optional experience-and-style Skill, not a platform plotting capability. Generate a paper-quality figure by picking a style template and filling it with user data. The bundled templates save `dpi=300` PNG files after their output path is adapted to the current task.

The scripts are imported templates, not directly runnable project commands. Their default PNG outputs are relative to the current working directory. Always copy the selected script into the current task directory and replace its data section and, when needed, its output filename before execution. Never edit the template in place.

## Available Styles

| Style | Type | Script | 适用场景 |
|-------|------|---------|---------|
| `bar_paired_delta` | 柱状图 | `scripts/bar_memevolve.py` | Baseline vs method 配对对比 + 增益箭头 |
| `bar_grouped_hatch` | 柱状图 | `scripts/bar_spice.py` | 多方法消融，主方法斜线填充，柱顶数值 |
| `line_confidence_band` | 折线图 | `scripts/line_selfdistill.py` | 带置信区间的训练曲线 |
| `line_training_curve` | 折线图 | `scripts/line_aime.py` | 垂直断点线 + 水平参考线 |
| `line_loss_with_inset` | 折线图 | `scripts/line_loss_inset.py` | L 形 spine + 局部放大 inset |
| `scatter_tsne_cluster` | 散点图 | `scripts/scatter_tsne.py` | t-SNE 聚类 + 注释框 |
| `scatter_broken_axis` | 散点图 | `scripts/scatter_break.py` | 折断 X 轴，多 marker 系列 |
| `radar_dual_series` | 雷达图 | `scripts/radar_dora.py` | 双方法多维对比，正八边形网格 |
| `heatmap_quantile_clipping` | 热力图/密度图 | N/A (guideline) | 空间/密度热力图，防止极值污染 colorbar，常用 5%–95% 截断 |

## Workflow

```
1. 确认用户的图类型和数据
2. 选择对应 style（如不确定，根据数据形状推断）
3. 读取对应 references/<style_name>.md 获取精确参数
4. 复制对应 `scripts/<script>.py` 到当前任务目录，替换数据区和 `savefig` 输出路径
5. 使用项目提示词指定的 Python 解释器运行复制后的脚本；不要调用裸 `python`
6. 检查输出，必要时微调颜色/标签/字号
```

## Data Substitution Tips

每个 repro 脚本的数据区在文件顶部，通常是 `np.array(...)` 或字典。替换规则：
- 保持数组维度和类型不变
- 若类别数变化（如从 4 组改为 6 组），同步调整颜色列表和宽度计算
- x 轴标签、图例标签直接修改对应字符串列表

## Detailed Style Parameters

Read the corresponding file in `references/` for exact `rcParams`, colors, font sizes, spine settings, and tick directions before generating:

- Bar: `references/bar_paired_delta.md`, `references/bar_grouped_hatch.md`
- Line: `references/line_confidence_band.md`, `references/line_training_curve.md`, `references/line_loss_with_inset.md`
- Scatter: `references/scatter_tsne_cluster.md`, `references/scatter_broken_axis.md`
- Radar: `references/radar_dual_series.md`
- Heatmap / density: `references/heatmap_quantile_clipping.md`
