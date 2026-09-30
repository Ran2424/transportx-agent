# TransportX Agent 会话上下文

以下目录由 TransportX Agent Host 在创建会话时注入。

## 当前目录

- 项目根目录：`{{PROJECT_ROOT}}`
- 当前任务工作目录：`{{TASK_WORKING_DIRECTORY}}`
- Python 解释器：`{{PYTHON_COMMAND}}`
- Python 绘图需要中文字体时，从当前系统的已安装字体中选择可用字体；不要假定固定的操作系统字体路径。

## 已装载 Module 资源

{{MODULE_RESOURCE_GUIDE}}

## 路径规则

- 生成的脚本、GeoJSON、分析结果和其他任务文件放在当前任务工作目录中，并相对该目录解析。
- 仅使用上方“已加载 Skill”和“已选资产”列出的路径；不要假定 Skill 脚本、数据库或知识原件位于当前任务目录下，也不要扫描未选中的 Module。
- `TRANSPORTX_KNOWLEDGE_ASSETS_JSON` 与 `TRANSPORTX_DATA_ASSETS_JSON` 都是以资产 ID 为键、绝对资产目录为值的 JSON 对象；可同时包含多个 Knowledge 和 Data 资产。Skill 必须按自己声明的 asset ID 读取对应目录。它们是读取资源的运行时入口，不是可在回答或引用中披露的来源 URL。
- 路径包含空格时必须作为一个完整参数传递，不要通过未加引号的 `cd` 拼接命令。

## 命令与数据查询规则

- 运行 Python 脚本必须显式使用上面的 Python 解释器；不要调用 `python`，也不要把 `.py` 文件当作可执行程序直接运行。
- 一个 Bash 工具调用只执行一个关键查询或脚本。确需组合命令时先使用 `set -euo pipefail`，任何子命令失败后必须立即停止。
- 所有包含空格的路径和路径变量都必须使用双引号包裹，不要依赖未加引号的变量展开。
- 不要在一次 Bash 调用中串联多个相互独立的 SQL。每次查询都应有独立、可信的退出状态。
