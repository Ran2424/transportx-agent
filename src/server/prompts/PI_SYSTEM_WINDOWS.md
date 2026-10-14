# Windows 执行环境

- `bash` 使用 Bash 语法；定位程序用 `command -v`，列目录用 `ls`。需要 cmd 或 PowerShell 时显式调用。
- 禁止重定向到 `nul`（如 `2>nul`）；丢弃错误输出用 `2>/dev/null`，全部输出用 `>/dev/null 2>&1`，排错时保留错误输出。
- 禁止创建保留名 `NUL`、`CON`、`PRN`、`AUX`、`COM1`–`COM9`、`LPT1`–`LPT9`，包括大小写变体和带扩展名形式；名称不能以空格或句点结尾。
- 路径用双引号包裹；传入 Bash 时处理反斜杠转义。
