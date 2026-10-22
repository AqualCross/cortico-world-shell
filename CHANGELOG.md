# Changelog

## 0.1.0

- 默认用 PowerShell 7(`pwsh`)执行命令,也可以把 `worlds.shell.shell` 指向 Niubash 的 `niu` 继续用 bash;每条命令在全新的进程里执行,超时或中断终止这次调用的进程树,停用 World 会中止在途调用,回执用 `[bg]` 报出仍存活的直接子进程。
- 默认 `ask-once`(同意后 30 分钟内不再问),默认不提示 RTK。
- 审批框显示工作目录、程序与命令头尾;默认按钮为「否」;命令上限 8000 字;控制符与双向字符转义后显示。
- 免询问名单在 World 启动时读取;RTK 只在开启提示时定位,不执行。
- 输出有界;收尾在捕获状态后复位 shell 设置,bash 的 `set -euo pipefail` 与 PowerShell 的 StrictMode 都不会打断收尾。
- 适配 Cortico world v6:`webUi()` 与 `describe.json`;按 shell 选择提示词与工具描述;仅支持 Windows。
