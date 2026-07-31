#!/usr/bin/env bash
# 编译 docs/report 下的 LaTeX 报告。
#  - 中间产物输出到 ./build/（被 .gitignore 忽略）
#  - 最终 PDF 以正式报告名拷回当前目录
#
# 用法：
#   ./build.sh                       编译两个版本
#   ./build.sh internal | 内部      只编译内部完整版
#   ./build.sh external | 对外|汇报  只编译外部汇报版
#   ./build.sh clean                 删除 build/ 与根目录 PDF
#
# 输出 PDF：
#   内部版：  重大活动交通态势洞察及辅助决策智能体集群-内部.pdf
#   对外版：  重大活动交通态势洞察及辅助决策智能体集群.pdf

set -euo pipefail
cd "$(dirname "$0")"

TITLE=重大活动交通态势洞察及辅助决策智能体集群
INTERNAL_PDF="${TITLE}-内部.pdf"
EXTERNAL_PDF="${TITLE}.pdf"

build_one() {
  local tex="$1" out="$2"
  echo "==> 编译 $tex → $(basename "$out")"
  latexmk -xelatex -output-directory=build "$tex"
  cp -f "build/${tex%.tex}.pdf" "$out"
}

case "${1:-all}" in
  internal|内部)
    build_one report.tex "$INTERNAL_PDF"
    ;;
  external|对外|汇报|brief)
    build_one report-brief.tex "$EXTERNAL_PDF"
    ;;
  all|"")
    build_one report.tex "$INTERNAL_PDF"
    build_one report-brief.tex "$EXTERNAL_PDF"
    ;;
  clean)
    rm -rf build
    rm -f "$INTERNAL_PDF" "$EXTERNAL_PDF"
    echo "==> 已清理 build/ 与根目录 PDF"
    ;;
  *)
    echo "用法: $0 [internal|external|all|clean]" >&2
    exit 1
    ;;
esac