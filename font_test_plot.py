from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.font_manager import FontProperties


FONT_PATH = Path("/Users/ran/Library/Fonts/msyh.ttc")
OUTPUT_PATH = Path(__file__).with_name("font_test_plot.png")
CHINESE_FONT = FontProperties(fname=FONT_PATH)

x = np.arange(1, 8)
y = np.array([12, 18, 15, 26, 23, 34, 31])

fig, ax = plt.subplots(figsize=(8, 4.8))
ax.plot(x, y, color="#5B0DAD", linewidth=2, marker="o", label="每日流量")
ax.axhline(y.mean(), color="#3D78C2", linewidth=1.5, linestyle="--", label="平均值")

ax.set_title("微软雅黑中文字体渲染测试", fontproperties=CHINESE_FONT, fontsize=18)
ax.set_xlabel("日期", fontproperties=CHINESE_FONT, fontsize=12)
ax.set_ylabel("交通流量（万辆）", fontproperties=CHINESE_FONT, fontsize=12)
ax.set_xticks(x, [f"第{i}天" for i in x], fontproperties=CHINESE_FONT)
ax.legend(prop=CHINESE_FONT, loc="upper left", frameon=True)
ax.tick_params(direction="out", length=4, width=0.8)

for spine in ax.spines.values():
    spine.set_visible(True)
    spine.set_linewidth(1)

ax.grid(False)
fig.tight_layout()
fig.savefig(OUTPUT_PATH, dpi=200, facecolor="white")
plt.close(fig)

print(f"font: {CHINESE_FONT.get_name()}")
print(f"saved: {OUTPUT_PATH}")
