# 报告目录

`重大活动交通态势洞察及辅助决策智能体集群` 项目报告的多格式源文件与产物。

## 目录结构

```
docs/report/
├── README.md                                  本文件
├── .gitignore                                 忽略 build/ 与 .DS_Store
├── build.sh                                   编译脚本（封装 latexmk + PDF 拷回根目录）
│
├── report.tex                                 LaTeX 源：内部完整版（八章 + 完整技术细节）
├── report-brief.tex                           LaTeX 源：外部汇报版（八章 + 精简）
├── 重大活动交通态势洞察及辅助决策智能体集群-内部.pdf   内部完整版 PDF（编译产出）
├── 重大活动交通态势洞察及辅助决策智能体集群.pdf         外部汇报版 PDF（编译产出）
│
├── 重大活动交通态势洞察及辅助决策智能体集群.md       Markdown 源：内部完整版（**以此为准**）
├── 重大活动交通态势洞察及辅助决策智能体集群-汇报版.md Markdown 源：外部汇报版
├── 重大活动交通智能体阶段工作汇报.md                Markdown 源：早期阶段汇报
│
├── 重大活动交通态势洞察及辅助决策智能体集群.docx     DOCX：原始模板（161 KB，最早一版）
├── 重大活动交通态势洞察及辅助决策智能体集群_完善稿.docx DOCX：完善稿（11.8 MB，含渲染插图）
├── 重大活动交通态势洞察及辅助决策智能体集群v2.docx   DOCX：最新版（1.8 MB）
│
├── assets/
│   └── 重大活动交通态势洞察及辅助决策智能体集群/   LaTeX 引用的业务截图
│       ├── 00-overall-architecture.png
│       ├── 01-transportx-home.png
│       ├── 02-metro-保障图.png
│       ├── 03-ridehail-dropoff-heatmap.png
│       ├── 04-report-preview.png
│       ├── 05-citation-detail.png
│       └── 06-evdata-road-pressure.png
│
└── build/                                     LaTeX 中间产物（git 忽略，无需关心）
    └── report{,‑brief}.{aux,fdb_latexmk,fls,log,out,toc,xdv,pdf}

注：`build/` 内的产物沿用 .tex 源名（`report.{aux,log,…}` / `report-brief.{aux,log,…}`），仅根目录的最终 PDF 使用上述正式报告名。
```

## 权威源（Source of Truth）

`重大活动交通态势洞察及辅助决策智能体集群.md`（完整版） / `…-汇报版.md`（汇报版）。

- **DOCX 与 LaTeX（PDF）均由 Markdown 派生**，三者在内容上应对齐。
- 若发现三者不一致，以 Markdown 为准并同步修订 DOCX / TeX 模板。

## 编译

依赖：TeX Live（含 `xelatex` + `ctex` 宏包）+ 系统 CJK 字体。

```bash
cd docs/report
./build.sh                       # 编译两个版本
./build.sh internal | 内部      # 只编译内部完整版
./build.sh external | 对外      # 只编译外部汇报版
./build.sh clean                 # 删除 build/ 与根目录 PDF
```

输出 PDF：

| 目标 | 文件名 |
|---|---|
| 内部完整版 | `重大活动交通态势洞察及辅助决策智能体集群-内部.pdf` |
| 外部汇报版 | `重大活动交通态势洞察及辅助决策智能体集群.pdf` |

`build.sh` 内部执行：

```
latexmk -xelatex -output-directory=build report.tex
cp -f build/report.pdf 重大活动交通态势洞察及辅助决策智能体集群-内部.pdf
```

- `build/` 收容所有 LaTeX 中间产物，被 `.gitignore` 忽略，不污染仓库
- 最终 PDF 自动拷回当前目录，与 `.tex` 源同级，方便查看与提交
- `tex` 源通过 `\graphicspath{{./assets/…}}` 引用截图，**必须在 `docs/report/` 下编译**

## 命名约定

| 后缀 | 含义 |
|---|---|
| `…-汇报版.md` | 外部精简版（八章结构对齐，正文压缩） |
| `…阶段工作汇报.md` | 早期（2026-07-24）领导汇报，已被完整版覆盖 |
| `…集群.docx` | 原始模板（封面 + 八个章节标题，无插图） |
| `…_完善稿.docx` | 含渲染插图的完善稿（11.8 MB） |
| `…v2.docx` | 整理后的最新 DOCX（1.8 MB） |