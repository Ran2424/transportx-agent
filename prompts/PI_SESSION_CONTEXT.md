# Tau 项目上下文

以下目录由 Tau 服务端在创建 Pi Web 会话时注入。

## 当前目录

- 项目根目录：`{{PROJECT_ROOT}}`
- 当前任务工作目录：`{{TASK_WORKING_DIRECTORY}}`
- 项目 Skills 目录：`{{PROJECT_SKILLS_DIR}}`
- Python 解释器：`/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10`

## 路径规则

- 生成的脚本、GeoJSON、分析结果和其他任务文件放在当前任务工作目录中，并相对该目录解析。
- Skill 脚本和数据库使用上面给出的明确目录，不要假定它们位于当前任务目录下。
- 路径包含空格时必须作为一个完整参数传递，不要通过未加引号的 `cd` 拼接命令。

## 命令与数据查询规则

- 运行 Python 脚本必须显式使用上面的 Python 解释器；不要调用 `python`，也不要把 `.py` 文件当作可执行程序直接运行。
- 一个 Bash 工具调用只执行一个关键查询或脚本。确需组合命令时先使用 `set -euo pipefail`，任何子命令失败后必须立即停止。
- 所有包含空格的路径和路径变量都必须使用双引号包裹，不要依赖未加引号的变量展开。
- 不要在一次 Bash 调用中串联多个相互独立的 SQL。每次查询都应有独立、可信的退出状态。
